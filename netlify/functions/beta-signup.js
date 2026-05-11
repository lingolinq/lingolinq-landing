// Netlify Function: beta-signup
//
// Accepts a JSON POST from /assets/form.js, validates input, then:
//   1. Submits to the HubSpot Forms API (which fires the configured
//      auto-response email and routes the contact into the CRM).
//   2. Sends a plain-text backup email to FORWARDER_TO_EMAIL via Resend,
//      so info@lingolinq.com gets a copy independent of HubSpot.
//
// Required env vars (set in Netlify dashboard):
//   HUBSPOT_PORTAL_ID            numeric portal id
//   HUBSPOT_FORM_GUID            uuid of the Beta Waitlist form in HubSpot
//   HUBSPOT_SUBSCRIPTION_TYPE_ID id of the marketing subscription in HubSpot
//   RESEND_API_KEY               re_... key from resend.com
//   FORWARDER_FROM_EMAIL         verified sender, e.g. beta@lingolinq.com
//   FORWARDER_TO_EMAIL           info@lingolinq.com
//
// HubSpot success is the source of truth. If the backup email fails we
// still return 200 to the browser. If HubSpot fails we return 502.

const crypto = require('node:crypto');

const HUBSPOT_FIELD_MAP = {
  email: 'email',
  firstname: 'firstname',
  organization: 'company',
  role: 'lingolinq_role',
  comments: 'message'
};

const ALLOWED_ROLES = new Set([
  'aac_user',
  'parent_family',
  'slp',
  'educator',
  'district_admin',
  'clinician',
  'other'
]);

// Server-controlled canonical consent text. Do not trust the client copy.
const CONSENT_TEXT_CANONICAL =
  'I am 18 or older. I agree to LingoLinq processing my information and sending me waitlist updates. I can withdraw at any time.';
const SUBSCRIPTION_PURPOSE_TEXT =
  'Marketing communications about the LingoLinq beta program.';

const isValidEmail = (s) =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

const truncate = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : '';

// Strip CRLF, tab, and angle brackets. Used for single-line fields that
// flow into email subjects or User-Agent headers.
const sanitizeLine = (s) => {
  const stripped = String(s)
    .split('').filter((ch) => {
      const c = ch.charCodeAt(0);
      if (c === 0x0A || c === 0x0D || c === 0x09) return false;
      if (c === 0x3C || c === 0x3E) return false;
      return true;
    }).join('');
  return stripped.slice(0, 400);
};

// Strip angle brackets only. Used for multi-line content like comments.
const sanitizeBody = (s) => {
  const stripped = String(s)
    .split('').filter((ch) => {
      const c = ch.charCodeAt(0);
      return c !== 0x3C && c !== 0x3E;
    }).join('');
  return stripped.slice(0, 2000);
};

// Hash a value for redacted log output. Lets us correlate failures without
// writing the original PII to logs that LingoLinq team members can read.
const fingerprint = (s) =>
  s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 10) : '-';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  const headers = event.headers || {};

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON.' });
  }

  // Honeypot. Silent accept; do not tell bots they were caught.
  if (payload.website) {
    console.log('[beta-signup] honeypot tripped', {
      ipFp: fingerprint((headers['x-forwarded-for'] || '').split(',')[0])
    });
    return json(200, { ok: true });
  }

  const email = truncate(payload.email, 254).trim().toLowerCase();
  const firstname = truncate(payload.firstname, 100).trim();
  const organization = truncate(payload.organization, 200).trim();
  const role = truncate(payload.role, 50).trim();
  const comments = truncate(payload.comments, 2000).trim();
  const consent = payload.consent === true;

  if (!isValidEmail(email)) {
    return json(400, { error: 'Please enter a valid email address.' });
  }
  if (!ALLOWED_ROLES.has(role)) {
    return json(400, { error: 'Please choose a role.' });
  }
  if (!consent) {
    return json(400, { error: 'Consent is required to join the waitlist.' });
  }

  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formGuid = process.env.HUBSPOT_FORM_GUID;

  if (!portalId || !formGuid) {
    console.error('[beta-signup] missing HUBSPOT_PORTAL_ID or HUBSPOT_FORM_GUID');
    return json(500, {
      error: 'Signup is temporarily unavailable. Please email info@lingolinq.com.'
    });
  }

  // Synthesize pageUri / pageName server-side. Client-sent values are
  // ignored because they are user-tampered and feed into HubSpot CRM views.
  const refererHeader = headers.referer || headers.referrer || '';
  let pageUri = 'https://lingolinq.com/';
  try {
    if (refererHeader) {
      const ref = new URL(refererHeader);
      if (ref.protocol === 'https:' && ref.host.endsWith('lingolinq.com')) {
        pageUri = ref.origin + ref.pathname;
      }
    }
  } catch {
    // fall through to default
  }
  const pageName = 'LingoLinq Beta Waitlist';
  const userAgent = sanitizeLine(headers['user-agent'] || 'lingolinq-landing');

  const hubspotPayload = {
    fields: [
      { name: HUBSPOT_FIELD_MAP.email, value: email },
      { name: HUBSPOT_FIELD_MAP.firstname, value: firstname },
      { name: HUBSPOT_FIELD_MAP.organization, value: organization },
      { name: HUBSPOT_FIELD_MAP.role, value: role },
      { name: HUBSPOT_FIELD_MAP.comments, value: comments }
    ].filter((f) => f.value !== ''),
    context: {
      pageUri,
      pageName
    },
    legalConsentOptions: {
      consent: {
        consentToProcess: true,
        text: CONSENT_TEXT_CANONICAL,
        communications: [
          {
            value: true,
            subscriptionTypeId: Number(process.env.HUBSPOT_SUBSCRIPTION_TYPE_ID) || 999,
            text: SUBSCRIPTION_PURPOSE_TEXT
          }
        ]
      }
    }
  };

  const emailFp = fingerprint(email);

  let hubspotOk = false;
  let hubspotErrorTag = null;
  try {
    const url = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(portalId)}/${encodeURIComponent(formGuid)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'lingolinq-landing/1.0'
      },
      body: JSON.stringify(hubspotPayload)
    });
    if (res.ok) {
      hubspotOk = true;
    } else {
      // Redacted log: status only, never the response body, because HubSpot
      // echoes submitted fields in error payloads.
      hubspotErrorTag = `status=${res.status}`;
      console.error('[beta-signup] hubspot reject', { emailFp, role, status: res.status });
    }
  } catch (err) {
    hubspotErrorTag = 'fetch_failed';
    console.error('[beta-signup] hubspot fetch failed', { emailFp, role, code: err && err.code });
  }

  // Backup email. Best effort. Never blocks success on its own.
  const resendKey = process.env.RESEND_API_KEY;
  const forwardFrom = process.env.FORWARDER_FROM_EMAIL;
  const forwardTo = process.env.FORWARDER_TO_EMAIL;

  if (resendKey && forwardFrom && forwardTo) {
    try {
      const safeEmail = sanitizeLine(email);
      const safeRole = sanitizeLine(role);
      const safeFirstname = sanitizeLine(firstname);
      const safeOrg = sanitizeLine(organization);
      const safeComments = sanitizeBody(comments);
      const safeUA = sanitizeLine(userAgent).slice(0, 200);

      const subject = `New beta signup: ${safeRole} (${safeEmail})`;
      const text = [
        `Email: ${safeEmail}`,
        `First name: ${safeFirstname || '(none)'}`,
        `Role: ${safeRole}`,
        `Organization: ${safeOrg || '(none)'}`,
        `Comments: ${safeComments || '(none)'}`,
        '',
        `User-Agent: ${safeUA}`,
        `Page: ${pageUri}`,
        `HubSpot: ${hubspotOk ? 'OK' : 'FAILED. ' + (hubspotErrorTag || 'unknown')}`,
        '',
        'This message was sent by the lingolinq.com beta signup form.'
      ].join('\n');

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: forwardFrom,
          to: forwardTo,
          subject,
          text
        })
      });
      if (!res.ok) {
        console.error('[beta-signup] forwarder email failed', { emailFp, status: res.status });
      }
    } catch (err) {
      console.error('[beta-signup] forwarder email threw', { emailFp, code: err && err.code });
    }
  } else {
    console.warn('[beta-signup] backup email not configured. RESEND_API_KEY/FORWARDER_* missing');
  }

  if (!hubspotOk) {
    return json(502, {
      error:
        'We could not save your signup right now. Please email info@lingolinq.com so we can add you by hand.'
    });
  }

  return json(200, { ok: true });
};

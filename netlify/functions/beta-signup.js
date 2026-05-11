// Netlify Function: beta-signup
//
// Accepts a JSON POST from /assets/form.js, validates input, then:
//   1. Submits to the HubSpot Forms API (which fires the configured
//      auto-response email and routes the contact into the CRM).
//   2. Sends a plain-text backup email to FORWARDER_TO_EMAIL via Resend,
//      so info@lingolinq.com gets a copy independent of HubSpot.
//
// Required env vars (set in Netlify dashboard):
//   HUBSPOT_PORTAL_ID      — numeric portal id
//   HUBSPOT_FORM_GUID      — uuid of the Beta Waitlist form in HubSpot
//   RESEND_API_KEY         — re_... key from resend.com
//   FORWARDER_FROM_EMAIL   — verified sender, e.g. beta@lingolinq.com
//   FORWARDER_TO_EMAIL     — info@lingolinq.com
//
// HubSpot success is the source of truth. If the backup email fails we
// still return 200 to the browser. If HubSpot fails we return 502.

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

const isValidEmail = (s) =>
  typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

const truncate = (value, max) =>
  typeof value === 'string' ? value.slice(0, max) : '';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON.' });
  }

  // Honeypot — if 'website' is filled, silently accept and drop.
  if (payload.website) {
    console.log('[beta-signup] honeypot tripped');
    return json(200, { ok: true });
  }

  const email = truncate(payload.email, 254).trim().toLowerCase();
  const firstname = truncate(payload.firstname, 100).trim();
  const organization = truncate(payload.organization, 200).trim();
  const role = truncate(payload.role, 50).trim();
  const comments = truncate(payload.comments, 2000).trim();
  const consent = payload.consent === true;
  const consentText = truncate(payload.consentText, 400);
  const pageUri = truncate(payload.pageUri, 400) || 'https://lingolinq.com/';
  const pageName = truncate(payload.pageName, 200) || 'LingoLinq Beta Signup';

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
    return json(500, { error: 'Signup is temporarily unavailable. Please email info@lingolinq.com.' });
  }

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || undefined;
  const userAgent = event.headers['user-agent'] || undefined;

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
      pageName,
      ipAddress: ip
    },
    legalConsentOptions: {
      consent: {
        consentToProcess: true,
        text:
          consentText ||
          "I agree to receive emails about LingoLinq's beta program and consent to processing.",
        communications: [
          {
            value: true,
            subscriptionTypeId: Number(process.env.HUBSPOT_SUBSCRIPTION_TYPE_ID) || 999,
            text: 'Marketing communications about the LingoLinq beta program.'
          }
        ]
      }
    }
  };

  let hubspotOk = false;
  let hubspotError = null;
  try {
    const url = `https://api.hsforms.com/submissions/v3/integration/submit/${encodeURIComponent(portalId)}/${encodeURIComponent(formGuid)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent || 'lingolinq-landing'
      },
      body: JSON.stringify(hubspotPayload)
    });
    if (res.ok) {
      hubspotOk = true;
    } else {
      const detail = await res.text().catch(() => '');
      hubspotError = `HubSpot ${res.status}: ${detail.slice(0, 500)}`;
      console.error('[beta-signup]', hubspotError);
    }
  } catch (err) {
    hubspotError = `HubSpot fetch failed: ${err && err.message ? err.message : String(err)}`;
    console.error('[beta-signup]', hubspotError);
  }

  // Backup email — best effort. Never blocks success on its own.
  const resendKey = process.env.RESEND_API_KEY;
  const forwardFrom = process.env.FORWARDER_FROM_EMAIL;
  const forwardTo = process.env.FORWARDER_TO_EMAIL;

  if (resendKey && forwardFrom && forwardTo) {
    try {
      const subject = `New beta signup: ${role} (${email})`;
      const text = [
        `Email: ${email}`,
        `First name: ${firstname || '(none)'}`,
        `Role: ${role}`,
        `Organization: ${organization || '(none)'}`,
        `Comments: ${comments || '(none)'}`,
        '',
        `IP: ${ip || '(unknown)'}`,
        `User-Agent: ${userAgent || '(unknown)'}`,
        `Page: ${pageUri}`,
        `HubSpot: ${hubspotOk ? 'OK' : 'FAILED. ' + (hubspotError || 'unknown')}`
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
        const detail = await res.text().catch(() => '');
        console.error('[beta-signup] forwarder email failed', res.status, detail.slice(0, 500));
      }
    } catch (err) {
      console.error('[beta-signup] forwarder email threw', err && err.message);
    }
  } else {
    console.warn('[beta-signup] backup email not configured — RESEND_API_KEY/FORWARDER_* missing');
  }

  if (!hubspotOk) {
    return json(502, {
      error: 'We could not save your signup right now. Please email info@lingolinq.com so we can add you by hand.'
    });
  }

  return json(200, { ok: true });
};

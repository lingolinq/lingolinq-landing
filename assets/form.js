// LingoLinq beta signup form handler.
// Posts to /.netlify/functions/beta-signup. Honeypot field 'website' must stay empty.

(function () {
  const form = document.getElementById('beta-form');
  const status = document.getElementById('form-status');
  const submit = document.getElementById('beta-submit');
  if (!form) return;

  const setStatus = (msg, cls) => {
    status.textContent = msg;
    status.classList.remove('success', 'error');
    if (cls) status.classList.add(cls);
  };

  const setInvalid = (id, isInvalid) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (isInvalid) el.setAttribute('aria-invalid', 'true');
    else el.removeAttribute('aria-invalid');
  };

  const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('');

    const data = {
      email: form.email.value.trim(),
      role: form.role.value,
      consent: form.consent.checked,
      website: form.website.value,
      consentText: form.querySelector('label[for="consent"]').textContent.trim(),
      pageUri: window.location.href,
      pageName: document.title
    };

    let firstInvalid = null;
    if (!isValidEmail(data.email)) { setInvalid('email', true); firstInvalid = firstInvalid || 'email'; }
    else setInvalid('email', false);

    if (!data.role) { setInvalid('role', true); firstInvalid = firstInvalid || 'role'; }
    else setInvalid('role', false);

    if (!data.consent) { setInvalid('consent', true); firstInvalid = firstInvalid || 'consent'; }
    else setInvalid('consent', false);

    if (firstInvalid) {
      setStatus('Please fill in the highlighted fields.', 'error');
      document.getElementById(firstInvalid).focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Sending...';
    setStatus('Sending...');

    try {
      const res = await fetch('/.netlify/functions/beta-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (res.ok) {
        form.reset();
        setStatus("Thanks. You're on the list. Look for a note from info@lingolinq.com.", 'success');
        submit.textContent = 'Joined';
        return;
      }

      const body = await res.json().catch(() => ({}));
      const msg = body && body.error ? body.error : 'Something went wrong. Please try again, or email info@lingolinq.com.';
      setStatus(msg, 'error');
      submit.disabled = false;
      submit.textContent = 'Join the beta';
    } catch (err) {
      setStatus('Something went wrong. Please try again, or email info@lingolinq.com.', 'error');
      submit.disabled = false;
      submit.textContent = 'Join the beta';
    }
  });
})();

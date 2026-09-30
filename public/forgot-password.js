import {
  $,
  clearErrors,
  devMailHint,
  focusFirstError,
  isEmail,
  renderHeroSeats,
  setBusy,
  setFieldError,
  showAlert,
} from './auth-ui.js';
import { api, describeError } from './session.js';

renderHeroSeats($('hero-seats'));
const prefill = new URLSearchParams(location.search).get('email');
if (prefill) $('email').value = prefill;
$('email').focus();

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  showAlert($('alert'), 'error');

  const email = $('email').value.trim();
  if (!isEmail(email)) {
    setFieldError($('email'), 'Enter a valid email address, like name@example.com.');
    return focusFirstError(form);
  }

  setBusy($('submit'), true);
  try {
    // Always answers the same way, whether or not the account exists (no account discovery).
    await api('/auth/password-reset/request', { method: 'POST', body: { email } });
    $('form-view').hidden = true;
    $('done-email').textContent = email;
    $('back-to-login').href = `/login?email=${encodeURIComponent(email)}`;
    $('done-view').hidden = false;
    const hint = devMailHint();
    if (hint) $('done-view').append(hint);
  } catch (err) {
    showAlert($('alert'), 'error', describeError(err));
  } finally {
    setBusy($('submit'), false);
  }
});

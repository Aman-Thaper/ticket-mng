import {
  $,
  applyValidationErrors,
  bindPasswordToggle,
  bindStrengthMeter,
  clearErrors,
  focusFirstError,
  renderHeroSeats,
  setBusy,
  setFieldError,
  showAlert,
} from './auth-ui.js';
import { api, describeError } from './session.js';

renderHeroSeats($('hero-seats'));
bindPasswordToggle($('password'), $('toggle-password'));
bindStrengthMeter($('password'), $('strength'));

// The token arrives in the URL fragment (#token=...), which browsers never send to servers,
// so it stays out of access logs and Referer headers. Drop it from the address bar at once
// so it doesn't linger in history either.
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

function show(view) {
  for (const id of ['form-view', 'done-view', 'error-view']) $(id).hidden = id !== view;
}

if (!token) {
  $('error-text').textContent =
    'This link is incomplete. Request a new one, and open the link from the latest email.';
  show('error-view');
} else {
  $('password').focus();
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  showAlert($('alert'), 'error');

  const newPassword = $('password').value;
  if (newPassword.length < 8) {
    setFieldError($('password'), 'Use at least 8 characters.');
    return focusFirstError(form);
  }

  setBusy($('submit'), true);
  try {
    await api('/auth/password-reset/confirm', { method: 'POST', body: { token, newPassword } });
    show('done-view');
  } catch (err) {
    if (err.code === 'INVALID_RESET_TOKEN') show('error-view');
    else if (!(err.code === 'VALIDATION_ERROR' && applyValidationErrors(err, { newPassword: $('password') })))
      showAlert($('alert'), 'error', describeError(err));
  } finally {
    setBusy($('submit'), false);
  }
});

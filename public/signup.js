import {
  $,
  applyValidationErrors,
  bindPasswordToggle,
  bindStrengthMeter,
  clearErrors,
  devMailHint,
  focusFirstError,
  isEmail,
  link,
  renderHeroSeats,
  setBusy,
  setFieldError,
  showAlert,
} from './auth-ui.js';
import { api, authenticate, describeError, nextPath, restoreSession, withNext } from './session.js';

renderHeroSeats($('hero-seats'));
bindPasswordToggle($('password'), $('toggle-password'));
bindStrengthMeter($('password'), $('strength'));

// /signup?role=organizer: an account for selling tickets, which starts on the dashboard.
const asOrganizer = new URLSearchParams(location.search).get('role') === 'organizer';
const next = nextPath(asOrganizer ? '/organizer' : '/');
if (asOrganizer) {
  document.title = 'Create an organizer account · Ticket MNG';
  $('form-title').textContent = 'Create an organizer account';
  $('form-sub').textContent =
    'Sell tickets to your events: live seat maps, a door scanner and sales numbers.';
  $('role-switch').hidden = true;
  $('continue').querySelector('.btn-label').textContent = 'Go to your events';
}
$('login-link').href = withNext('/login', next);
$('continue').href = next;
$('name').focus();

if (await restoreSession()) location.replace(next);

const fields = { name: $('name'), email: $('email'), password: $('password') };

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  showAlert($('alert'), 'error');

  const name = $('name').value.trim();
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!name) setFieldError($('name'), 'Enter your name.');
  if (!isEmail(email)) setFieldError($('email'), 'Enter a valid email address, like name@example.com.');
  if (password.length < 8) setFieldError($('password'), 'Use at least 8 characters.');
  if (form.querySelector('[aria-invalid="true"]')) return focusFirstError(form);

  setBusy($('submit'), true);
  try {
    const user = await authenticate('/auth/signup', {
      name,
      email,
      password,
      ...(asOrganizer ? { role: 'organizer' } : {}),
    });
    showConfirmationStep(user.email);
  } catch (err) {
    setBusy($('submit'), false);
    if (err.code === 'EMAIL_TAKEN') {
      setFieldError($('email'), 'An account with this email already exists.');
      showAlert(
        $('alert'),
        'error',
        'You already have an account. ',
        link(
          `${withNext('/login', next)}${next === '/' ? '?' : '&'}email=${encodeURIComponent(email)}`,
          'Log in instead',
        ),
        '?',
      );
    } else if (err.code === 'VALIDATION_ERROR' && applyValidationErrors(err, fields)) {
      focusFirstError(form);
    } else {
      showAlert($('alert'), 'error', describeError(err));
    }
  }
});

function showConfirmationStep(email) {
  $('form-view').hidden = true;
  $('done-email').textContent = email;
  $('done-view').hidden = false;
  const hint = devMailHint();
  if (hint) $('done-view').append(hint);
  $('continue').focus();
}

$('resend').addEventListener('click', async () => {
  setBusy($('resend'), true);
  try {
    const { message } = await api('/auth/verify-email/resend', { method: 'POST' });
    showAlert($('done-alert'), 'success', `${message} Check your spam folder too.`);
  } catch (err) {
    showAlert($('done-alert'), 'error', describeError(err));
  } finally {
    setBusy($('resend'), false);
  }
});

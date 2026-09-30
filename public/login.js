import {
  $,
  bindPasswordToggle,
  clearErrors,
  focusFirstError,
  isEmail,
  link,
  renderHeroSeats,
  setBusy,
  setFieldError,
  showAlert,
} from './auth-ui.js';
import { authenticate, describeError, nextPath, restoreSession, withNext } from './session.js';

renderHeroSeats($('hero-seats'));
bindPasswordToggle($('password'), $('toggle-password'));

const params = new URLSearchParams(location.search);
const next = nextPath();
$('signup-link').href = withNext('/signup', next);
if (params.get('email')) $('email').value = params.get('email');
if (params.get('reset') === '1') {
  showAlert($('alert'), 'success', 'Your password was changed. Log in with your new password.');
}
if ($('email').value) $('password').focus();
else $('email').focus();

// Already logged in (say, from another tab)? Carry on to where they were going.
if (await restoreSession()) location.replace(next);

$('forgot-link').addEventListener('click', (e) => {
  const email = $('email').value.trim();
  if (isEmail(email)) e.currentTarget.href = `/forgot-password?email=${encodeURIComponent(email)}`;
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  clearErrors(form);
  showAlert($('alert'), 'error');

  const email = $('email').value.trim();
  const password = $('password').value;
  if (!isEmail(email)) setFieldError($('email'), 'Enter a valid email address, like name@example.com.');
  if (!password) setFieldError($('password'), 'Enter your password.');
  if (!isEmail(email) || !password) return focusFirstError(form);

  setBusy($('submit'), true);
  try {
    await authenticate('/auth/login', { email, password });
    location.assign(next);
  } catch (err) {
    setBusy($('submit'), false);
    if (err.code === 'INVALID_CREDENTIALS') {
      // One message for "no such account" and "wrong password": the API doesn't say which.
      showAlert(
        $('alert'),
        'error',
        'Incorrect email or password. ',
        link(`/forgot-password?email=${encodeURIComponent(email)}`, 'Forgot your password?'),
      );
      $('password').select();
    } else {
      showAlert($('alert'), 'error', describeError(err));
    }
  }
});

import { $, devMailHint, renderHeroSeats, setBusy, showAlert } from './auth-ui.js';
import { api, describeError, restoreSession, session } from './session.js';

renderHeroSeats($('hero-seats'));

// Same fragment trick as password reset links: the token never reaches server logs.
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

function show(view) {
  for (const id of ['loading-view', 'done-view', 'error-view']) $(id).hidden = id !== view;
}

async function confirm() {
  if (!token) return showError();
  try {
    const { status } = await api('/auth/verify-email', { method: 'POST', body: { token } });
    if (status === 'already_verified')
      $('done-text').textContent = "Your email address was already confirmed. You're all set.";
    show('done-view');
    $('continue').focus();
  } catch (err) {
    if (err.code === 'INVALID_VERIFICATION_TOKEN') return showError();
    show('error-view');
    showAlert($('error-alert'), 'error', describeError(err));
  }
}

async function showError() {
  show('error-view');
  // Logged in here? Then a new link is one click away; otherwise, log in first.
  if (await restoreSession()) {
    if (session.user.emailVerified) {
      $('done-text').textContent = "Your email address is already confirmed. You're all set.";
      return show('done-view');
    }
    $('resend').hidden = false;
    $('login-to-resend').hidden = true;
  } else {
    $('login-to-resend').href = `/login?next=${encodeURIComponent('/')}`;
  }
}

$('resend').addEventListener('click', async () => {
  setBusy($('resend'), true);
  try {
    const { message } = await api('/auth/verify-email/resend', { method: 'POST' });
    showAlert($('error-alert'), 'success', `${message} Check your spam folder too.`);
    const hint = devMailHint();
    if (hint && !$('error-view').querySelector('.dev-hint')) $('error-view').append(hint);
  } catch (err) {
    showAlert($('error-alert'), 'error', describeError(err));
  } finally {
    setBusy($('resend'), false);
  }
});

await confirm();

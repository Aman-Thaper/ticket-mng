// The reset token arrives in the URL fragment (#token=...). Fragments are never sent to
// servers, so the token stays out of access logs and Referer headers. Remove it from the
// address bar straight away so it doesn't linger in browser history either.
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

const form = document.getElementById('reset-form');
const message = document.getElementById('message');

if (!token) {
  form.hidden = true;
  message.textContent = 'This link is missing its reset token. Request a new email.';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password').value;
  if (password !== document.getElementById('confirm').value) {
    message.textContent = "The passwords don't match.";
    return;
  }
  const res = await fetch('/api/v1/auth/password-reset/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword: password }),
  });
  if (res.status === 204) {
    form.hidden = true;
    message.classList.add('ok');
    message.textContent =
      'Password changed. Every existing session was logged out; log in with the new password.';
  } else {
    const body = await res.json().catch(() => null);
    message.textContent = body?.error?.message ?? 'Something went wrong.';
  }
});

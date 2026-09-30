// UI helpers shared by the account pages (log in, sign up, reset, confirm email).

export const $ = (id) => document.getElementById(id);

/** Show/hide a password field. The button reflects its state for screen readers. */
export function bindPasswordToggle(input, button) {
  button.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    button.querySelector('.label').textContent = show ? 'Hide' : 'Show';
    input.focus();
  });
}

/**
 * A rough password strength estimate for the meter. The server only enforces a minimum
 * length (NIST guidance: length beats composition rules); this nudges towards long ones.
 */
export function passwordStrength(password) {
  if (password.length < 8) return { score: password ? 1 : 0, label: password ? 'Too short' : '' };
  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((re) => re.test(password)).length;
  let score = 2;
  if (password.length >= 12 || variety >= 3) score = 3;
  if (password.length >= 16 || (password.length >= 12 && variety >= 3)) score = 4;
  if (/^(.)\1+$/.test(password) || /^(password|12345678|qwerty)/i.test(password)) score = 1;
  return { score, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] };
}

export function bindStrengthMeter(input, meter) {
  const bars = meter.querySelectorAll('.bar');
  const text = meter.querySelector('.strength-label');
  const update = () => {
    const { score, label } = passwordStrength(input.value);
    meter.dataset.score = String(score);
    bars.forEach((bar, i) => bar.classList.toggle('on', i < score));
    text.textContent = label;
  };
  input.addEventListener('input', update);
  update();
}

// ─── form state ────────────────────────────────────────────────────────────────────────

/** Mark a field invalid, with its message wired up for screen readers. */
export function setFieldError(input, message) {
  const field = input.closest('.field');
  const slot = field.querySelector('.field-error');
  field.classList.toggle('invalid', Boolean(message));
  input.setAttribute('aria-invalid', String(Boolean(message)));
  slot.textContent = message ?? '';
  if (message) {
    slot.id ||= `${input.id}-error`;
    input.setAttribute('aria-describedby', slot.id);
  } else {
    input.removeAttribute('aria-describedby');
  }
}

export function clearErrors(form) {
  for (const input of form.querySelectorAll('input')) setFieldError(input, null);
}

/** Map the API's validation details ({ path: "body.email", message }) onto form fields. */
export function applyValidationErrors(err, fields) {
  let applied = false;
  for (const { path, message } of err.details ?? []) {
    const input = fields[String(path).split('.').pop()];
    if (input) {
      setFieldError(input, message.charAt(0).toUpperCase() + message.slice(1));
      applied = true;
    }
  }
  return applied;
}

/** Disable a submit button and show a spinner while a request runs. */
export function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.setAttribute('aria-busy', String(busy));
}

/** kind: 'error' | 'success' | 'info'. content: a string or DOM nodes. */
export function showAlert(el, kind, ...content) {
  el.className = `alert alert-${kind}`;
  el.replaceChildren(...content);
  el.hidden = content.length === 0;
}

export function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
}

export const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Focus the first invalid field, so keyboard and screen-reader users land on the problem. */
export function focusFirstError(form) {
  form.querySelector('[aria-invalid="true"]')?.focus();
}

/**
 * Locally, emails don't leave the machine: Mailpit catches them. Say so, only when running
 * on localhost, so a developer isn't left waiting for an email that went to Mailpit.
 */
export function devMailHint() {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  const p = document.createElement('p');
  p.className = 'dev-hint';
  p.append(
    'Running locally? Emails are caught by Mailpit: ',
    link('http://localhost:8025', 'open the inbox'),
    '.',
  );
  return p;
}

// ─── the decorative seat map on the left of the account pages ──────────────────────────

export function renderHeroSeats(container) {
  if (!container) return;
  const rows = 9;
  const cols = 16;
  // Deterministic "random" statuses, so the picture doesn't flicker between visits.
  let seed = 7;
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const frag = document.createDocumentFragment();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const seat = document.createElement('span');
      const aisle = c === 3 || c === 12;
      const roll = next();
      seat.className = aisle ? 'seat gap' : roll < 0.42 ? 'seat sold' : roll < 0.52 ? 'seat held' : 'seat';
      frag.append(seat);
    }
  }
  container.append(frag);
}

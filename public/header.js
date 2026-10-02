// The header shared by the catalog, event and ticket pages: brand, navigation, the account
// menu, and the "confirm your email" banner. Pages call mountHeader() once; it re-renders
// itself whenever the session changes (login, logout, email confirmed).
import { api, describeError, logout, onSessionChange, reloadUser, session, withNext } from './session.js';

const LOGO =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9a3 3 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a3 3 0 0 0 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1z" /><path d="M13 5v2M13 11v2M13 17v2" /></svg>';
const CHEVRON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>';

// Static markup only: every value that comes from the server is set with textContent.
const TEMPLATE = `
  <a class="brand" href="/"><span class="logo">${LOGO}</span><span>Ticket MNG</span></a>
  <nav class="main-nav" aria-label="Main">
    <a href="/" data-nav="events">Events</a>
    <a href="/my-tickets" data-nav="tickets">My tickets</a>
  </nav>
  <div class="account">
    <div id="guest" class="guest">
      <a id="login-link" class="nav-link" href="/login">Log in</a>
      <a id="signup-link" class="nav-button" href="/signup">Sign up</a>
    </div>
    <span id="offline-pill" class="offline-pill" hidden>Offline</span>
    <div id="user-menu" class="user-menu" hidden>
      <button id="menu-button" class="menu-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="menu">
        <span id="avatar" class="avatar" aria-hidden="true"></span>
        <span id="menu-name" class="menu-name"></span>
        ${CHEVRON}
      </button>
      <div id="menu" class="menu" role="menu" hidden>
        <div class="menu-head">
          <strong id="menu-full-name"></strong>
          <span id="menu-email"></span>
          <span id="menu-verified" class="verified-badge"></span>
        </div>
        <a href="/my-tickets" role="menuitem">My tickets</a>
        <a id="scanner-link" href="/scan" role="menuitem" hidden>Door scanner</a>
        <button id="logout" type="button" role="menuitem">Log out</button>
      </div>
    </div>
  </div>`;

const BANNER = `
  <span>Confirm your email address to book tickets. We sent a link to <strong id="banner-email"></strong>.</span>
  <button id="resend" type="button" class="banner-action">Resend email</button>
  <span id="banner-note" class="banner-note" role="status" aria-live="polite"></span>`;

const $ = (id) => document.getElementById(id);

// The service worker makes the site installable and its pages (and saved tickets) open
// offline: sw.js. Browsers allow it on HTTPS and localhost only. Registered once the page
// has loaded, so its downloads don't compete with the page's own.
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

const initials = (name) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('') || '?';

/**
 * active: which nav item to highlight ('events' | 'tickets').
 * onLogout: called after logging out (pages clear what they showed for the user).
 */
export function mountHeader({ active, onLogout } = {}) {
  const header = $('site-header');
  header.className = 'site-header';
  header.innerHTML = TEMPLATE;
  header.querySelector(`[data-nav="${active}"]`)?.setAttribute('aria-current', 'page');

  const banner = document.createElement('div');
  banner.id = 'verify-banner';
  banner.className = 'banner';
  banner.hidden = true;
  banner.innerHTML = BANNER;
  header.after(banner);

  // Log in / sign up bring you back to this exact page (including filters or the event).
  for (const [id, page] of [
    ['login-link', '/login'],
    ['signup-link', '/signup'],
  ]) {
    $(id).addEventListener('click', (e) => {
      e.currentTarget.href = withNext(page);
    });
  }

  const openMenu = () => {
    $('menu').hidden = false;
    $('menu-button').setAttribute('aria-expanded', 'true');
    $('menu').querySelector('[role="menuitem"]').focus();
  };
  const closeMenu = () => {
    $('menu').hidden = true;
    $('menu-button').setAttribute('aria-expanded', 'false');
  };
  $('menu-button').addEventListener('click', () => ($('menu').hidden ? openMenu() : closeMenu()));
  document.addEventListener('click', (e) => {
    if (!$('user-menu').contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('menu').hidden) {
      closeMenu();
      $('menu-button').focus();
    }
  });

  $('logout').addEventListener('click', async () => {
    await logout();
    onLogout?.();
  });

  $('resend').addEventListener('click', async () => {
    $('resend').disabled = true;
    try {
      const { message } = await api('/auth/verify-email/resend', { method: 'POST' });
      $('banner-note').textContent = message;
    } catch (err) {
      if (err.code === 'EMAIL_ALREADY_VERIFIED') await reloadUser();
      else $('banner-note').textContent = describeError(err);
    } finally {
      $('resend').disabled = false;
    }
  });

  // Confirmed the address in another tab (the email link opens one)? Notice on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session.user && !session.user.emailVerified) {
      reloadUser().catch(() => {});
    }
  });

  const render = (user) => {
    // Offline, a signed-in visitor isn't logged out: the session just couldn't be checked.
    const offline = !user && session.offline;
    $('guest').hidden = Boolean(user) || offline;
    $('offline-pill').hidden = !offline;
    $('user-menu').hidden = !user;
    if (user) {
      $('avatar').textContent = initials(user.name);
      $('menu-name').textContent = user.name.split(/\s+/)[0];
      $('menu-full-name').textContent = user.name;
      $('menu-email').textContent = user.email;
      $('menu-verified').textContent = user.emailVerified ? 'Email confirmed' : 'Email not confirmed yet';
      $('menu-verified').classList.toggle('pending', !user.emailVerified);
      $('scanner-link').hidden = user.role === 'attendee';
    } else {
      closeMenu();
    }
    banner.hidden = !user || user.emailVerified;
    if (user && !user.emailVerified) $('banner-email').textContent = user.email;
  };
  onSessionChange(render);
  render(session.user);
}

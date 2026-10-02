# 0014. Offline tickets: public files in the service worker, tickets in IndexedDB

**Status:** accepted

## Context

People open their tickets at the venue door, in a crowd of thousands sharing the same cell towers. A ticket page that needs the network fails exactly when it matters. The email has the QR codes too, but finding an email in a queue is slower, and mail apps don't always keep attachments offline.

Making pages work offline means storing things in the browser. Some of it is public (the pages and scripts); some is personal (bookings, QR codes). Browsers are shared: a family laptop, a friend's phone used to log in once.

## Decision

- **A service worker caches public files only:** pages, scripts, styles, icons. API requests pass straight through it and are never cached there.
- **Network first:** online, every request goes to the server and refreshes the cached copy; offline, or after 4 s without an answer, the cached copy is served. Files are precached at install, one at a time, so a missing file can't break the install.
- **The user's tickets live in IndexedDB:** one snapshot (bookings, plus QR codes of upcoming bookings), written by My tickets on every online load and by the event page after a purchase.
- **The snapshot lives exactly as long as the session.** It's deleted on logout, on login (whoever was logged in before), and when the server rejects a session refresh (expired, revoked, logged out elsewhere).
- **Offline is not logged out.** When the session refresh fails for lack of network, pages know (`session.offline`): My tickets shows the saved copy with a banner, and the header says "Offline" instead of "Log in".

## Consequences

- The QR codes open with no signal at all, on any device where My tickets was opened once (or a ticket bought) since login.
- A saved ticket can be out of date (refunded, or used). That's safe: the scanner checks validity at the door, and the signature makes a copy indistinguishable from the original anyway.
- Releases go live on the next page load, with no "update available, reload" dance. The cost: on a slow connection, a page waits up to 4 s before falling back.
- Someone who uses a person's unlocked browser while still logged in can see their saved tickets offline. That's the same exposure as the logged-in session itself, and it ends with the session.
- Service workers need HTTPS or localhost, so phone testing needs a tunnel or the deployed site.

## Alternatives considered

- **Cache API responses in the service worker** (bookings, tickets): simplest, but Cache Storage isn't tied to a login. One user's tickets would stay on the device after logout and appear for the next user offline. Filtering by user inside the worker would rebuild what IndexedDB plus session-scoped clearing does more plainly.
- **Cache first (stale-while-revalidate) for pages:** faster on bad connections, but every release needs a second load to show up, and scripts from two releases can mix. Network first with a timeout gives most of the speed with none of the staleness.
- **localStorage:** synchronous (reading it blocks the page), strings only, and capped at about 5 MB. IndexedDB is asynchronous and stores the objects as they are; the lifetime rules above apply either way.
- **A native app:** the usual answer for offline tickets, but it's a second codebase for one feature that the web platform now covers.

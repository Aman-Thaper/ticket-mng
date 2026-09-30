# 0011. Booking requires a confirmed email address

**Status:** accepted

## Context

Tickets are delivered by email: the QR codes go to the address the buyer logs in with. An account created with a typo (`gmial.com`), or with someone else's address, would send paid tickets to a stranger or to nowhere, and the buyer would only find out at the door. Signup itself shouldn't get harder: people should be able to create an account and look around at once.

## Decision

- **Signup sends a confirmation link**, queued through the outbox in the same transaction that creates the account. `users.email_verified_at` stays null until the link is used.
- **Holding seats requires a confirmed address** (`403 EMAIL_NOT_VERIFIED`). Everything else works right away: logging in, browsing, the live seat map. The seat map explains what's missing and offers to resend the link.
- **The token is minted by the worker**, not in the signup request, so the raw token never sits in the outbox table or in Redis job data. Only its SHA-256 hash is stored, and it travels in the URL fragment (`/verify-email#token=…`), which browsers never send to servers.
- **Confirming is idempotent.** Opening the link twice, or on two devices, answers "already verified", not an error. Several unexpired links can be valid at once: a resend doesn't break the email already in the inbox. Confirmation proves only "this address works", so there's nothing to gain by limiting it to the newest link, unlike password reset tokens.
- **Resending is authenticated and rate-limited** (3 per hour per account). It needs a login rather than an email field, so it can't be used to bomb arbitrary inboxes.
- **Existing accounts were grandfathered** by the migration: they're treated as confirmed.

## Consequences

- A booking's tickets always go to an inbox that has already received and acted on one of our emails.
- One indexed lookup per hold (`users` by primary key). It's negligible next to the booking transaction, and always current. Carrying a claim in the access token would avoid it, but would lag for up to 15 minutes after confirming in another tab.
- Signing up and buying immediately now takes one more click (the link). The account page and seat map say so explicitly, and locally the dev hint points to Mailpit.
- Tests and scripts that create users directly must decide whether they're confirmed (`createUser(role, { verified })`).

## Alternatives considered

- **No confirmation:** simplest, but tickets can silently go to the wrong address.
- **Confirm before login:** a common pattern, but it blocks browsing too, for no benefit here.
- **Confirm at checkout, with a one-time code:** less friction on signup, but it moves the extra step to the most time-critical moment of a flash sale, while the seat hold is ticking.

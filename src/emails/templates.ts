import type { Mail } from '../lib/mailer.js';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ─── building blocks ───────────────────────────────────────────────────────────────────
// Email HTML is its own world: no external CSS, patchy support for modern layout, and
// Outlook renders with Word. So: tables for layout, inline styles only, and a plain-text
// version of every message for clients (and people) who prefer it.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = '#64748b';
const LABEL = `font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:${MUTED}`;

/**
 * The shared shell: brand header, a white card, and a footer.
 * `preview` is the line inboxes show next to the subject; it's hidden in the message itself.
 */
function layout({
  title,
  preview,
  body,
  footer,
}: {
  title: string;
  preview: string;
  body: string;
  footer?: string;
}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:${FONT};color:#0f172a">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px">
<span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;background:#2563eb;color:#ffffff;font-weight:700;font-size:15px;vertical-align:middle">T</span>
<span style="font-size:18px;font-weight:700;vertical-align:middle;padding-left:8px">Ticket MNG</span>
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px 28px;font-size:15px;line-height:1.55">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escape(title)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.5;color:${MUTED}">
${footer ?? 'You received this email because of activity on your Ticket MNG account.'}<br>© Ticket MNG
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

const button = (href: string, label: string) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td style="border-radius:8px;background:#2563eb">
<a href="${escape(href)}" style="display:inline-block;padding:13px 24px;color:#ffffff;font-weight:600;text-decoration:none;border-radius:8px">${escape(label)}</a>
</td></tr></table>`;

const fallbackLink = (href: string) =>
  `<p style="margin:0;font-size:13px;color:${MUTED}">If the button doesn't work, paste this link into your browser:<br><a href="${escape(href)}" style="color:#2563eb;word-break:break-all">${escape(href)}</a></p>`;

const note = (html: string) =>
  `<p style="margin:24px 0 0;padding:14px 16px;background:#eff6ff;border-radius:10px;font-size:14px;color:#1e3a8a">${html}</p>`;

// ─── account emails ────────────────────────────────────────────────────────────────────

export function emailVerificationEmail(
  to: { email: string; name: string },
  link: string,
  ttlHours: number,
): Mail {
  return {
    to: to.email,
    subject: 'Confirm your email address',
    text: `Hi ${to.name},\n\nWelcome to Ticket MNG! Your tickets will be sent to ${to.email}, so please confirm that this address is yours:\n${link}\n\nThe link is valid for ${ttlHours} hours. If you didn't create an account, ignore this email.`,
    html: layout({
      title: 'Confirm your email address',
      preview: 'One click, and you can start booking.',
      body: `<p style="margin:0 0 12px">Hi ${escape(to.name)},</p>
<p style="margin:0">Welcome to Ticket MNG! Your tickets will be sent to <strong>${escape(to.email)}</strong>, so please confirm that this address is yours.</p>
${button(link, 'Confirm my email')}
${fallbackLink(link)}
<p style="margin:16px 0 0;font-size:13px;color:${MUTED}">The link is valid for ${ttlHours} hours.</p>`,
      footer:
        "You received this email because this address was used to create a Ticket MNG account. If that wasn't you, ignore it: nothing happens without a click.",
    }),
  };
}

export function passwordResetEmail(
  to: { email: string; name: string },
  link: string,
  ttlMinutes: number,
): Mail {
  return {
    to: to.email,
    subject: 'Reset your password',
    text: `Hi ${to.name},\n\nUse this link to choose a new password (valid for ${ttlMinutes} minutes):\n${link}\n\nIf you didn't ask for this, ignore this email; your password stays unchanged.`,
    html: layout({
      title: 'Reset your password',
      preview: `Choose a new password. The link works for ${ttlMinutes} minutes.`,
      body: `<p style="margin:0 0 12px">Hi ${escape(to.name)},</p>
<p style="margin:0">Use the button below to choose a new password. The link is valid for ${ttlMinutes} minutes and works once.</p>
${button(link, 'Choose a new password')}
${fallbackLink(link)}`,
      footer: "If you didn't ask for a new password, ignore this email: your password stays unchanged.",
    }),
  };
}

// ─── booking emails ────────────────────────────────────────────────────────────────────

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);

// Venues don't store a time zone yet, so times are shown in UTC and labelled as such.
const when = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(d) +
  ' UTC';

export interface TicketForEmail {
  id: string;
  section: string;
  row: string;
  number: number;
  qrPng: Buffer;
}

export interface BookingForEmail {
  id: string;
  totalCents: number;
  currency: string;
  event: { title: string; startsAt: Date; venueName: string; venueAddress: string; city: string };
}

/** The "When / Where" box shared by the booking emails. */
const eventDetails = (ev: BookingForEmail['event']) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
<tr><td style="padding:16px 18px">
<div style="${LABEL}">When</div>
<div style="font-weight:600;margin:2px 0 14px">${escape(when(ev.startsAt))}</div>
<div style="${LABEL}">Where</div>
<div style="font-weight:600;margin-top:2px">${escape(ev.venueName)}</div>
<div style="color:#475569">${escape(ev.venueAddress)}, ${escape(ev.city)}</div>
</td></tr></table>`;

export function bookingConfirmedEmail(
  to: { email: string; name: string },
  booking: BookingForEmail,
  tickets: TicketForEmail[],
): Mail {
  const seatLine = (t: TicketForEmail) => `${t.section}, row ${t.row}, seat ${t.number}`;
  const ev = booking.event;
  const ticketCards = tickets
    .map(
      (
        t,
        i,
      ) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0;border:1px solid #e2e8f0;border-radius:10px">
<tr><td style="padding:14px 18px;border-bottom:1px dashed #cbd5e1">
<div style="${LABEL}">Ticket ${i + 1} of ${tickets.length}</div>
<div style="font-size:17px;font-weight:700;margin-top:2px">${escape(t.section)} · Row ${escape(t.row)} · Seat ${t.number}</div>
</td></tr>
<tr><td align="center" style="padding:20px 18px 16px">
<img src="cid:ticket-${t.id}" width="200" height="200" alt="QR code for ${escape(seatLine(t))}" style="display:block;width:200px;height:200px;border:0">
<div style="margin-top:8px;font-family:Menlo,Consolas,monospace;font-size:11px;color:#94a3b8">${t.id}</div>
</td></tr></table>`,
    )
    .join('\n');

  return {
    to: to.email,
    subject: `Your tickets: ${ev.title}`,
    text:
      `Hi ${to.name},\n\nYou're going to ${ev.title}!\n${when(ev.startsAt)}\n${ev.venueName}, ${ev.venueAddress}, ${ev.city}\n\n` +
      tickets.map((t) => `- ${seatLine(t)}`).join('\n') +
      `\n\nTotal paid: ${money(booking.totalCents, booking.currency)}\nBooking reference: ${booking.id}\n\n` +
      'Your QR tickets are attached. Show them at the door; each one can be scanned once.',
    html: layout({
      title: `You're going to ${ev.title}`,
      preview: `${tickets.length} ticket${tickets.length === 1 ? '' : 's'} for ${when(ev.startsAt)}. Show the QR codes at the door.`,
      body: `<p style="margin:0">Hi ${escape(to.name)}, your booking is confirmed. Here ${tickets.length === 1 ? 'is your ticket' : 'are your tickets'}.</p>
${eventDetails(ev)}
${ticketCards}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;font-size:14px">
<tr><td style="color:#475569">Total paid</td><td align="right" style="font-weight:700">${escape(money(booking.totalCents, booking.currency))}</td></tr>
<tr><td style="color:#475569;padding-top:6px">Booking reference</td><td align="right" style="padding-top:6px;font-family:Menlo,Consolas,monospace;font-size:12px">${booking.id}</td></tr>
</table>
${note('Show the QR code at the entrance, on your phone or printed. Each code admits one person, once. The codes are also attached to this email.')}`,
      footer: 'You received this email because you booked tickets on Ticket MNG.',
    }),
    attachments: tickets.map((t) => ({
      filename: `ticket-${t.section}-${t.row}${t.number}.png`.replace(/\s+/g, '-'),
      content: t.qrPng,
      contentType: 'image/png',
      cid: `ticket-${t.id}`,
    })),
  };
}

export function eventReminderEmail(
  to: { email: string; name: string },
  booking: BookingForEmail,
  seats: string[],
): Mail {
  const ev = booking.event;
  return {
    to: to.email,
    subject: `Tomorrow: ${ev.title}`,
    text: `Hi ${to.name},\n\nA reminder that ${ev.title} is tomorrow:\n${when(ev.startsAt)}\n${ev.venueName}, ${ev.venueAddress}, ${ev.city}\n\nYour seats: ${seats.join('; ')}\n\nYour QR tickets are in your confirmation email and in the app.`,
    html: layout({
      title: `${ev.title} is tomorrow`,
      preview: `See you there: ${when(ev.startsAt)}.`,
      body: `<p style="margin:0">Hi ${escape(to.name)}, a reminder that your event is tomorrow.</p>
${eventDetails(ev)}
<p style="margin:20px 0 0"><span style="${LABEL}">Your seats</span><br><strong>${seats.map(escape).join('<br>')}</strong></p>
${note('Your QR tickets are in your confirmation email and in the app.')}`,
      footer: 'You received this email because you booked tickets on Ticket MNG.',
    }),
  };
}

const REFUND_TEXT: Record<string, (event: string, amount: string) => { subject: string; body: string }> = {
  requested_by_customer: (event, amount) => ({
    subject: `Refund processed: ${event}`,
    body: `Your refund of ${amount} for ${event} has been processed. Your tickets are no longer valid.`,
  }),
  event_cancelled: (event, amount) => ({
    subject: `Cancelled: ${event}`,
    body: `We're sorry: ${event} has been cancelled. We've refunded your ${amount}.`,
  }),
  hold_expired: (event, amount) => ({
    subject: `Payment refunded: ${event}`,
    body: `Your payment of ${amount} for ${event} came through after your seat reservation had ended, and the seats were no longer available. We've refunded it in full.`,
  }),
  duplicate_payment: (event, amount) => ({
    subject: `Duplicate payment refunded: ${event}`,
    body: `You were charged twice for the same booking for ${event}. We've refunded the extra ${amount}.`,
  }),
};

export function refundProcessedEmail(
  to: { email: string; name: string },
  refund: { reason: string; amountCents: number; currency: string; eventTitle: string },
): Mail {
  const amount = money(refund.amountCents, refund.currency);
  const { subject, body } = (REFUND_TEXT[refund.reason] ?? REFUND_TEXT.requested_by_customer!)(
    refund.eventTitle,
    amount,
  );
  return {
    to: to.email,
    subject,
    text: `Hi ${to.name},\n\n${body}\n\nIt can take 5–10 business days to show on your statement.`,
    html: layout({
      title: subject,
      preview: body,
      body: `<p style="margin:0 0 12px">Hi ${escape(to.name)},</p><p style="margin:0">${escape(body)}</p>
${note('It can take 5–10 business days to show on your statement.')}`,
    }),
  };
}

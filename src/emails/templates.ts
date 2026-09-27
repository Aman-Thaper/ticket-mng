import type { Mail } from '../lib/mailer.js';

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Shared shell: plain, inline-styled HTML that renders in every mail client. */
function layout(title: string, body: string): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">
<h1 style="font-size:20px;margin:0 0 16px">${escape(title)}</h1>
${body}
<p style="margin-top:32px;font-size:12px;color:#71717a">Ticket MNG</p>
</div></body></html>`;
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
    html: layout(
      'Reset your password',
      `<p>Hi ${escape(to.name)},</p>
<p>Use the button below to choose a new password. The link is valid for ${ttlMinutes} minutes and works once.</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Choose a new password</a></p>
<p style="font-size:13px;color:#52525b">If you didn't ask for this, ignore this email; your password stays unchanged.</p>`,
    ),
  };
}

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

export function bookingConfirmedEmail(
  to: { email: string; name: string },
  booking: BookingForEmail,
  tickets: TicketForEmail[],
): Mail {
  const seatLine = (t: TicketForEmail) => `${t.section}, row ${t.row}, seat ${t.number}`;
  const ev = booking.event;
  return {
    to: to.email,
    subject: `Your tickets: ${ev.title}`,
    text:
      `Hi ${to.name},\n\nYou're going to ${ev.title}!\n${when(ev.startsAt)}\n${ev.venueName}, ${ev.venueAddress}, ${ev.city}\n\n` +
      tickets.map((t) => `- ${seatLine(t)}`).join('\n') +
      `\n\nTotal paid: ${money(booking.totalCents, booking.currency)}\nBooking reference: ${booking.id}\n\n` +
      'Your QR tickets are attached. Show them at the door; each one can be scanned once.',
    html: layout(
      `You're going to ${ev.title}`,
      `<p>Hi ${escape(to.name)},</p>
<p><strong>${escape(when(ev.startsAt))}</strong><br>${escape(ev.venueName)}, ${escape(ev.venueAddress)}, ${escape(ev.city)}</p>
${tickets
  .map(
    (
      t,
    ) => `<div style="border:1px solid #e4e4e7;border-radius:8px;padding:16px;margin:12px 0;text-align:center">
<div style="font-weight:600">${escape(seatLine(t))}</div>
<img src="cid:ticket-${t.id}" width="220" height="220" alt="Ticket QR code" style="margin-top:8px">
<div style="font-size:11px;color:#71717a">Ticket ${t.id}</div></div>`,
  )
  .join('\n')}
<p>Total paid: <strong>${escape(money(booking.totalCents, booking.currency))}</strong><br>
<span style="font-size:13px;color:#52525b">Booking reference: ${booking.id}</span></p>
<p style="font-size:13px;color:#52525b">Show the QR codes at the door. Each one can be scanned once.</p>`,
    ),
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
    html: layout(
      `${ev.title} is tomorrow`,
      `<p>Hi ${escape(to.name)},</p>
<p><strong>${escape(when(ev.startsAt))}</strong><br>${escape(ev.venueName)}, ${escape(ev.venueAddress)}, ${escape(ev.city)}</p>
<p>Your seats: ${seats.map(escape).join('; ')}</p>
<p style="font-size:13px;color:#52525b">Your QR tickets are in your confirmation email and in the app.</p>`,
    ),
  };
}

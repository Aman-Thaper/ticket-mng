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

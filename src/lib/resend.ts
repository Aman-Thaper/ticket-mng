import { UnrecoverableError } from 'bullmq';
import type { Attachment } from 'nodemailer/lib/mailer/index.js';

/*
 * A minimal client for Resend's email API: https://resend.com/docs/api-reference/emails/send-email
 *
 * One endpoint, called with fetch rather than an SDK, so every detail is visible here. What
 * the HTTP API gives us over SMTP:
 *   - idempotency keys: a retried job with the same key can't send the email twice (Resend
 *     remembers keys for 24 hours), which closes the gap between "sent" and "recorded as sent";
 *   - precise errors: a bad API key or an unverified domain is a different answer from
 *     "slow down", so jobs retry only when retrying can help.
 */

export interface ResendMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Same shape as nodemailer's, so templates work with either transport. */
  attachments?: Attachment[];
}

export interface ResendSendOptions {
  /** Emails with the same key within 24 hours are sent once. Up to 256 characters. */
  idempotencyKey?: string;
  /** What kind of email this is: becomes a tag you can filter by in Resend's dashboard. */
  category?: string;
}

export interface ResendResult {
  id: string | null;
  /** The key was already used for this email: it went out on an earlier attempt. */
  duplicate?: boolean;
}

/** A failure worth retrying: rate limited, a concurrent attempt, or Resend having trouble. */
export class ResendError extends Error {
  override name = 'ResendError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

// Answers that the same request will get again, however often it's retried: a bad or
// restricted API key, an unverified sending domain, an invalid address or attachment.
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 405, 422]);
// Quotas reset at midnight (daily) or next month: retrying within the job's backoff can't help.
const QUOTA_ERRORS = new Set(['daily_quota_exceeded', 'monthly_quota_exceeded']);

export class ResendClient {
  private readonly baseUrl: string;

  constructor(private readonly options: { apiKey: string; baseUrl?: string; timeoutMs?: number }) {
    this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/$/, '');
  }

  async send(
    message: ResendMessage,
    { idempotencyKey, category }: ResendSendOptions = {},
  ): Promise<ResendResult> {
    const res = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(category ? { tags: [{ name: 'category', value: category }] } : {}),
        ...(message.attachments?.length ? { attachments: message.attachments.map(toResendAttachment) } : {}),
      }),
      // A hung connection must not hold a worker slot forever. If the email did go out,
      // the retry carries the same idempotency key and Resend won't send it twice.
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });

    const body = (await res.json().catch(() => null)) as {
      id?: string;
      name?: string;
      message?: string;
    } | null;
    if (res.ok) return { id: body?.id ?? null };

    const code = body?.name;
    const detail = `Resend answered ${res.status}${code ? ` ${code}` : ''}: ${body?.message ?? res.statusText}`;
    // The key was used before with a slightly different body (say, the event was renamed
    // between attempts). Either way this email already went out: don't send it again.
    if (res.status === 409 && code === 'invalid_idempotent_request') return { id: null, duplicate: true };
    // Dead-letter straight away: an admin can retry once the key, domain or quota is fixed.
    if (QUOTA_ERRORS.has(code ?? '') || PERMANENT_STATUSES.has(res.status))
      throw new UnrecoverableError(detail);
    // 409 concurrent_idempotent_requests, 429 rate_limit_exceeded, 5xx: the job retries with backoff.
    throw new ResendError(detail, res.status, code);
  }
}

/** nodemailer's attachment shape → Resend's: base64 content, and content_id for inline images. */
function toResendAttachment(a: Attachment) {
  const content =
    Buffer.isBuffer(a.content) || typeof a.content === 'string'
      ? Buffer.from(a.content).toString('base64')
      : null;
  if (!content) throw new UnrecoverableError(`Attachment ${String(a.filename)} has no in-memory content`);
  return {
    filename: typeof a.filename === 'string' ? a.filename : 'attachment',
    content,
    ...(a.contentType ? { content_type: a.contentType } : {}),
    // Referenced from the HTML as <img src="cid:…">: shown inline, like the QR codes.
    ...(a.cid ? { content_id: a.cid } : {}),
  };
}

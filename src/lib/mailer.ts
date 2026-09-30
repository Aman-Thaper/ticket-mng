import nodemailer from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer/index.js';
import { config } from '../config.js';
import { ResendClient, type ResendResult, type ResendSendOptions } from './resend.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export type SendOptions = ResendSendOptions;
export type SendResult = ResendResult;

/** Mail "sent" with MAIL_TRANSPORT=memory ends up here, so tests can assert on it. */
export const sentMail: (Mail & SendOptions)[] = [];

type Transport = (mail: Mail, options: SendOptions) => Promise<SendResult>;

/**
 * One interface, three ways out (MAIL_TRANSPORT):
 *   resend: Resend's HTTP API. Idempotency keys make retried jobs safe (see lib/resend.ts).
 *   smtp:   any SMTP server. Mailpit locally, which catches everything at localhost:8025.
 *   memory: nothing leaves the process; for tests.
 */
function createTransport(): Transport {
  const envelope = { from: config.MAIL_FROM, replyTo: config.MAIL_REPLY_TO };
  switch (config.MAIL_TRANSPORT) {
    case 'resend': {
      const resend = new ResendClient({ apiKey: config.RESEND_API_KEY!, baseUrl: config.RESEND_API_URL });
      return (mail, options) => resend.send({ ...envelope, ...mail }, options);
    }
    case 'smtp': {
      const smtp = nodemailer.createTransport(config.SMTP_URL);
      return async (mail) => {
        const info = (await smtp.sendMail({ ...envelope, ...mail })) as { messageId?: string };
        return { id: info.messageId ?? null };
      };
    }
    case 'memory':
      return async (mail, options) => {
        sentMail.push({ ...mail, ...options });
        return { id: `memory-${sentMail.length}` };
      };
  }
}

const transport = createTransport();

export function sendMail(mail: Mail, options: SendOptions = {}): Promise<SendResult> {
  return transport(mail, options);
}

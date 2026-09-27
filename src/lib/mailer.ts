import nodemailer from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer/index.js';
import { config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

/** Mail "sent" with MAIL_TRANSPORT=memory ends up here, so tests can assert on it. */
export const sentMail: Mail[] = [];

const transport = config.MAIL_TRANSPORT === 'smtp' ? nodemailer.createTransport(config.SMTP_URL) : null;

export async function sendMail(mail: Mail): Promise<void> {
  if (!transport) {
    sentMail.push(mail);
    return;
  }
  await transport.sendMail({ from: config.MAIL_FROM, ...mail });
}

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnrecoverableError } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResendClient, ResendError, type ResendMessage } from '../../src/lib/resend.js';

/**
 * The Resend client against a stand-in for Resend's API: the request it sends, and how each
 * answer is classified (success, already sent, retry later, or give up for good).
 */

interface Captured {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let requests: Captured[] = [];
let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      requests.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: JSON.parse(raw || '{}'),
      });
      setTimeout(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  reply = { status: 200, body: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } };
});

const client = (timeoutMs?: number) => new ResendClient({ apiKey: 're_test_123', baseUrl, timeoutMs });

const message: ResendMessage = {
  from: 'Ticket MNG <tickets@example.com>',
  to: 'ada@example.com',
  subject: 'Your tickets: Test Concert',
  html: '<img src="cid:ticket-1">',
  text: 'Your tickets',
  replyTo: 'support@example.com',
  attachments: [
    {
      filename: 'ticket-A1.png',
      content: Buffer.from('png bytes'),
      contentType: 'image/png',
      cid: 'ticket-1',
    },
  ],
};

const errorReply = (status: number, name: string) => ({
  status,
  body: { statusCode: status, name, message: `${name} happened` },
});

describe('ResendClient', () => {
  it('posts the email, with the idempotency key, a tag, and inline attachments', async () => {
    const result = await client().send(message, {
      idempotencyKey: 'booking-confirmed/b-1',
      category: 'booking-confirmed',
    });
    expect(result).toEqual({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });

    const [req] = requests;
    expect(req).toMatchObject({ method: 'POST', url: '/emails' });
    expect(req!.headers.authorization).toBe('Bearer re_test_123');
    expect(req!.headers['idempotency-key']).toBe('booking-confirmed/b-1');
    expect(req!.body).toEqual({
      from: 'Ticket MNG <tickets@example.com>',
      to: ['ada@example.com'],
      subject: 'Your tickets: Test Concert',
      html: '<img src="cid:ticket-1">',
      text: 'Your tickets',
      reply_to: 'support@example.com',
      tags: [{ name: 'category', value: 'booking-confirmed' }],
      attachments: [
        {
          filename: 'ticket-A1.png',
          content: Buffer.from('png bytes').toString('base64'),
          content_type: 'image/png',
          content_id: 'ticket-1', // referenced as cid:ticket-1: shown inline, not as a download
        },
      ],
    });
  });

  it('omits the optional fields when they are not given', async () => {
    await client().send({ ...message, replyTo: undefined, attachments: undefined });
    const { headers, body } = requests[0]!;
    expect(headers['idempotency-key']).toBeUndefined();
    expect(body).not.toHaveProperty('reply_to');
    expect(body).not.toHaveProperty('tags');
    expect(body).not.toHaveProperty('attachments');
  });

  it('treats "key reused with a different payload" as already sent, not as a failure', async () => {
    reply = errorReply(409, 'invalid_idempotent_request');
    await expect(client().send(message, { idempotencyKey: 'k' })).resolves.toEqual({
      id: null,
      duplicate: true,
    });
  });

  it.each([
    [429, 'rate_limit_exceeded'],
    [409, 'concurrent_idempotent_requests'],
    [500, 'application_error'],
    [503, 'service_unavailable'],
  ])('retries later on %i %s', async (status, name) => {
    reply = errorReply(status, name);
    const err = await client()
      .send(message)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResendError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(err).toMatchObject({ status, code: name });
  });

  it.each([
    [401, 'missing_api_key'],
    [403, 'validation_error'], // e.g. the sending domain isn't verified
    [422, 'invalid_attachment'],
    [429, 'daily_quota_exceeded'],
  ])('gives up for good on %i %s (dead-lettered, not retried)', async (status, name) => {
    reply = errorReply(status, name);
    const err = await client()
      .send(message)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain(name);
  });

  it('times out a hung request, as a retryable error', async () => {
    reply = { status: 200, body: { id: 'late' }, delayMs: 500 };
    const err = await client(50)
      .send(message)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).name).toBe('TimeoutError');
  });
});

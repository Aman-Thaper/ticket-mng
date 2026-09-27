import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ensureBucket, publicUrl } from '../../src/lib/storage.js';
import {
  createEvent,
  createUser,
  createVenue,
  publish,
  runQueuedJobs,
  useApp,
  type TestUser,
} from '../helpers.js';

// Talks to the real MinIO (scripts/dev-services.sh), in the ticket-media-test bucket.

interface Presigned {
  url: string;
  fields: Record<string, string>;
  key: string;
}

/** What a browser does with the presigned POST: a multipart form straight to storage. */
function uploadTo(presigned: Presigned, body: Buffer, contentType: string) {
  const form = new FormData();
  for (const [name, value] of Object.entries(presigned.fields)) form.append(name, value);
  form.append('Content-Type', contentType);
  form.append('file', new Blob([new Uint8Array(body)], { type: contentType }), 'poster');
  return fetch(presigned.url, { method: 'POST', body: form });
}

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } } })
    .png()
    .toBuffer();

describe('event posters', () => {
  const t = useApp();
  let organizer: TestUser;
  let eventId: string;

  const presign = (user = organizer, id = eventId) =>
    t.app.inject({ method: 'POST', url: `/api/v1/events/${id}/poster/upload-url`, headers: user.auth });
  const attach = (key: string, id = eventId) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1/events/${id}/poster`,
      headers: organizer.auth,
      payload: { key },
    });
  const poster = async () => (await t.app.inject({ url: `/api/v1/events/${eventId}` })).json().poster;

  beforeAll(async () => {
    await ensureBucket();
  });

  beforeEach(async () => {
    organizer = await createUser('organizer');
    const venueId = (await createVenue(t.app, organizer)).id;
    eventId = (await createEvent(t.app, organizer, venueId)).json().id;
    await publish(t.app, organizer, eventId);
  });

  it('uploads straight to storage, then a worker produces public WebP variants', async () => {
    const presigned: Presigned = (await presign()).json();
    expect(presigned.key).toMatch(new RegExp(`^uploads/posters/${eventId}/`));
    const upload = await uploadTo(presigned, await png(2000, 1000), 'image/png');
    expect(upload.status).toBe(204);

    const res = await attach(presigned.key);
    expect(res.statusCode).toBe(202);
    expect(await poster()).toEqual({ status: 'processing', urls: null, error: null });

    await runQueuedJobs();
    const ready = await poster();
    expect(ready.status).toBe('ready');

    // Variants are public (no credentials) and have the promised sizes.
    for (const [size, width] of [
      ['small', 320],
      ['medium', 640],
      ['large', 1280],
    ] as const) {
      const img = await fetch(ready.urls[size]);
      expect(img.status).toBe(200);
      expect(img.headers.get('content-type')).toBe('image/webp');
      expect(img.headers.get('cache-control')).toContain('immutable');
      const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', width, width / 2]);
    }

    // The original stays private.
    expect((await fetch(publicUrl(presigned.key))).status).toBe(403);
  });

  it('storage itself refuses uploads that are not images', async () => {
    const presigned: Presigned = (await presign()).json();
    const res = await uploadTo(presigned, Buffer.from('#!/bin/sh\necho pwned'), 'text/x-shellscript');
    expect(res.status).toBe(403);
  });

  it('marks the poster failed when the "image" turns out not to be one', async () => {
    const presigned: Presigned = (await presign()).json();
    await uploadTo(presigned, Buffer.from('definitely not a png'), 'image/png');
    await attach(presigned.key);
    await expect(runQueuedJobs()).rejects.toThrow(/poster rejected/);
    expect(await poster()).toMatchObject({
      status: 'failed',
      urls: null,
      error: expect.stringContaining('not a supported image'),
    });
  });

  it('only accepts keys issued for this event that were actually uploaded', async () => {
    const other = (await createEvent(t.app, organizer, (await createVenue(t.app, organizer)).id)).json().id;
    const foreign: Presigned = (await presign(organizer, other)).json();
    expect((await attach(foreign.key)).json().error.code).toBe('INVALID_UPLOAD_KEY');

    const unused: Presigned = (await presign()).json();
    expect((await attach(unused.key)).json().error.code).toBe('UPLOAD_NOT_FOUND');
  });

  it("other organizers can't upload a poster for someone else's event", async () => {
    expect((await presign(await createUser('organizer'))).statusCode).toBe(403);
  });
});

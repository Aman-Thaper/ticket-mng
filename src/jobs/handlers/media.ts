import { UnrecoverableError } from 'bullmq';
import sharp from 'sharp';
import { db } from '../../db/index.js';
import { bumpGenerations, generationKey } from '../../lib/cache.js';
import { getObject, putObject } from '../../lib/storage.js';
import type { Jobs } from '../queues.js';
import type { JobHandler } from '../runner.js';

/** Widths served to clients: thumbnail, card, hero. */
export const POSTER_WIDTHS = [320, 640, 1280] as const;

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff']);
/** Rejects "decompression bombs": tiny files that expand to billions of pixels. */
const MAX_INPUT_PIXELS = 40_000_000;

/**
 * Turn an uploaded original into web-ready WebP variants.
 *
 * Runs in the worker because image processing is CPU-heavy: on an API server it would stall
 * every other request on the same event loop. The upload itself never touched the API
 * (presigned POST), so the API only records the key and enqueues this job.
 */
export const processPoster: JobHandler<Jobs['media']['process-poster']> = async (job, log) => {
  const { eventId, key } = job.data;
  const original = await getObject(key);

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.format || !ACCEPTED_FORMATS.has(meta.format))
      throw new Error(`unsupported format: ${meta.format ?? 'unknown'}`);
  } catch (err) {
    // Not an image (or a hostile one): retrying won't help.
    await db
      .updateTable('events')
      .set({ posterStatus: 'failed', posterError: 'The uploaded file is not a supported image' })
      .where('id', '=', eventId)
      .where('posterKey', '=', key)
      .execute();
    await bumpGenerations(generationKey.event(eventId), generationKey.eventLists);
    throw new UnrecoverableError(`poster rejected: ${(err as Error).message}`);
  }

  const uploadId = key.split('/').at(-1)!;
  const variants: Record<string, string> = {};
  for (const width of POSTER_WIDTHS) {
    const webp = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate() // apply EXIF orientation before metadata is stripped
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const variantKey = `posters/${eventId}/${uploadId}/${width}.webp`;
    // The key changes with every upload, so the files can be cached forever.
    await putObject(variantKey, webp, 'image/webp', 'public, max-age=31536000, immutable');
    variants[width] = variantKey;
  }

  // Only publish if this is still the latest upload. An organizer may have uploaded a
  // newer poster while this job was running.
  const updated = await db
    .updateTable('events')
    .set({ posterStatus: 'ready', posterVariants: JSON.stringify(variants), posterError: null })
    .where('id', '=', eventId)
    .where('posterKey', '=', key)
    .executeTakeFirst();
  if (updated.numUpdatedRows === 0n) log.info('a newer poster was uploaded meanwhile; result discarded');
  else await bumpGenerations(generationKey.event(eventId), generationKey.eventLists);

  return {
    width: meta.width,
    height: meta.height,
    format: meta.format,
    variants: Object.keys(variants).length,
  };
};

import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { config } from '../config.js';

/*
 * Object storage through the S3 API: MinIO locally, S3, R2, etc. in production.
 *
 * Uploads never pass through the API servers. The API signs a short-lived "presigned POST"
 * that allows exactly one upload (fixed key, max size, image content type), and the browser
 * sends the file straight to storage. The API tier never buffers a 10 MB image, which
 * would tie up memory and connections on the servers we most want to keep fast.
 *
 * Bucket layout:
 *   uploads/...   originals as uploaded: private
 *   posters/...   processed variants:    public-read (bucket policy), cacheable forever
 */

const credentials = { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY };
const Bucket = config.S3_BUCKET;

/** For server-to-server calls (inside Docker this is e.g. http://minio:9000). */
export const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials,
  forcePathStyle: true,
});

/** Signs URLs the browser will use, so they must carry the browser-facing host. */
const s3Public = new S3Client({
  endpoint: config.S3_PUBLIC_URL,
  region: config.S3_REGION,
  credentials,
  forcePathStyle: true,
});

export const publicUrl = (key: string) => `${config.S3_PUBLIC_URL}/${Bucket}/${key}`;

let bucketReady: Promise<void> | undefined;

/** Create the bucket and its public-read policy for posters/ if missing (dev convenience). */
export function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    try {
      await s3.send(new HeadBucketCommand({ Bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket }));
    }
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${Bucket}/posters/*`],
            },
          ],
        }),
      }),
    );
  })().catch((err: unknown) => {
    bucketReady = undefined; // retry next time
    throw err;
  });
  return bucketReady;
}

export interface PresignedUpload {
  url: string;
  fields: Record<string, string>;
  key: string;
  maxBytes: number;
  expiresAt: string;
}

const UPLOAD_TTL_SECONDS = 600;

export async function presignPosterUpload(eventId: string): Promise<PresignedUpload> {
  const key = `uploads/posters/${eventId}/${randomUUID()}`;
  const { url, fields } = await createPresignedPost(s3Public, {
    Bucket,
    Key: key,
    Conditions: [
      ['content-length-range', 1, config.POSTER_MAX_BYTES],
      ['starts-with', '$Content-Type', 'image/'],
    ],
    Expires: UPLOAD_TTL_SECONDS,
  });
  return {
    url,
    fields,
    key,
    maxBytes: config.POSTER_MAX_BYTES,
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return { size: head.ContentLength ?? 0, contentType: head.ContentType };
  } catch (err) {
    if (
      err instanceof NotFound ||
      (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)
    )
      return null;
    throw err;
  }
}

export async function getObject(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  return Buffer.from(await res.Body!.transformToByteArray());
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
  cacheControl?: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
    }),
  );
}

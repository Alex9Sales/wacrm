// ============================================================
// Server-only S3/MinIO client + object helpers.
//
// MinIO replaces Supabase Storage in Phase 3. The browser can't hold
// S3 credentials, so every upload/delete goes through a server route
// that uses THIS module. Nothing here is importable from a client
// component — it reads secret env (S3_SECRET_KEY etc.).
//
// Lazy singleton in the style of src/db/index.ts: nothing connects at
// import time, and missing env fails loudly at first use instead of
// producing a cryptic AWS SDK error deep in a request.
// ============================================================

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

let _client: S3Client | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add the S3/MinIO storage vars to .env.local ` +
        `(S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY).`,
    );
  }
  return value;
}

/** Lazily-constructed, shared S3 client pointed at the MinIO server. */
export function getS3Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      endpoint: requireEnv("S3_ENDPOINT"),
      region: requireEnv("S3_REGION"),
      credentials: {
        accessKeyId: requireEnv("S3_ACCESS_KEY"),
        secretAccessKey: requireEnv("S3_SECRET_KEY"),
      },
      // MinIO needs path-style addressing (bucket in the path, not the
      // host) unless the deployment is behind virtual-host DNS.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return _client;
}

/**
 * Public URL a browser (or Meta) can fetch an object at. Both buckets
 * are public-read, so this is a plain URL — no presigning.
 *
 * Prefers S3_PUBLIC_URL (the CDN / reverse-proxy origin) and falls back
 * to the raw S3_ENDPOINT when it isn't configured.
 */
export function publicUrl(bucket: string, key: string): string {
  const base = (process.env.S3_PUBLIC_URL ?? requireEnv("S3_ENDPOINT")).replace(
    /\/+$/,
    "",
  );
  return `${base}/${bucket}/${key}`;
}

/** Upload (or overwrite) an object. Body is the raw file bytes. */
export async function putObject(
  bucket: string,
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Delete an object. Best-effort — S3 delete is idempotent. */
export async function deleteObject(bucket: string, key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
  );
}

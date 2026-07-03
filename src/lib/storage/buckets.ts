// ============================================================
// Server-only bucket-name mapping.
//
// Callers speak in FRIENDLY bucket names ('avatars' | 'media') so the
// client never learns the real MinIO bucket names. The upload/delete
// routes translate a friendly name to the configured env value here and
// reject anything not on the whitelist.
// ============================================================

/** Friendly bucket names the media routes accept from clients. */
export type FriendlyBucket = "avatars" | "media";

export const FRIENDLY_BUCKETS: readonly FriendlyBucket[] = [
  "avatars",
  "media",
];

export function isFriendlyBucket(value: unknown): value is FriendlyBucket {
  return value === "avatars" || value === "media";
}

/**
 * Resolve a friendly bucket name to the real MinIO bucket configured in
 * env. Throws if the name is off-whitelist or the env var is missing.
 */
export function resolveBucket(friendly: FriendlyBucket): string {
  const envVar = friendly === "avatars" ? "S3_BUCKET_AVATARS" : "S3_BUCKET_MEDIA";
  const real = process.env[envVar];
  if (!real) {
    throw new Error(`${envVar} is not set. Add it to .env.local.`);
  }
  return real;
}

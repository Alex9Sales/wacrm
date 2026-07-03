// ============================================================
// Client-importable media-upload helper.
//
// Phase 3 moved storage from Supabase Storage to MinIO/S3. The browser
// can't hold S3 credentials, so uploads now POST a multipart FormData
// to the server route POST /api/media/upload, which authenticates the
// caller, builds the account-scoped key, and puts the bytes into MinIO.
// This module stays importable from client components — it only calls
// `fetch`; the S3 client + secrets live server-side in lib/storage/s3.
//
// Object-key convention (built server-side, unchanged from Supabase):
//   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
//
// The `account-<uuid>` first segment scopes every object to an account;
// the delete route verifies it so a caller can only remove objects
// under their own account folder (replacing the old bucket RLS guard).
// ============================================================

/** 16 MB — the media upload ceiling enforced by the server route. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/** Friendly bucket names the upload route accepts. */
export type FriendlyBucket = "avatars" | "media";

/**
 * Map a caller's bucket name to a friendly bucket the route accepts.
 *
 * Callers still pass their historical Supabase bucket names
 * ('chat-media', 'flow-media', 'avatars', 'media'); everything that
 * isn't avatar storage lands in the shared public 'media' bucket. Meta
 * still fetches by URL, so the single media bucket is fine.
 */
function toFriendlyBucket(bucket: string): FriendlyBucket {
  return bucket === "avatars" ? "avatars" : "media";
}

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without any network, and reused by the server
 * upload route to construct the real key.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Public URL Meta can fetch at send time. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

/**
 * Upload a file to an account-scoped MinIO bucket via the server route
 * and return its public URL + object path. Throws with a user-facing
 * message on failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES` is exported for the common case, and the
 * route enforces it as a hard ceiling regardless.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("bucket", toFriendlyBucket(bucket));

  let res: Response;
  try {
    res = await fetch("/api/media/upload", { method: "POST", body: form });
  } catch {
    throw new Error("Upload failed — could not reach the server.");
  }

  if (!res.ok) {
    let message = `Upload failed (HTTP ${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // Non-JSON body — keep the generic message.
    }
    throw new Error(message);
  }

  const data = (await res.json()) as UploadAccountMediaResult;
  return { publicUrl: data.publicUrl, path: data.path };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate in the public bucket. The
 * server route verifies the path is under the caller's own account
 * folder before deleting (replaces the old account-scoped RLS policy).
 *
 * Best-effort: callers fire-and-forget. We still throw on a definite
 * failure so a caller that wants to log it can.
 */
export async function deleteAccountMedia(
  bucket: string,
  path: string,
): Promise<void> {
  const res = await fetch("/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket: toFriendlyBucket(bucket), path }),
  });
  if (!res.ok) {
    throw new Error(`Delete failed (HTTP ${res.status}).`);
  }
}

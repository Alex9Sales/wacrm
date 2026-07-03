// ============================================================
// POST /api/media/delete — best-effort GC of a staged object.
//
// Replaces the Supabase Storage RLS delete guard: a caller may only
// delete objects under their OWN account folder. We enforce that by
// checking the path prefix against the caller's accountId before
// touching MinIO. Used to clean up media that was uploaded but never
// sent (a cancelled draft or a failed Meta send) so abandoned
// attachments don't accumulate in the public bucket.
//
// Request  (application/json): { bucket: 'avatars'|'media', path }
// Response (200): { ok: true } · 401 · 403 · 400
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isFriendlyBucket, resolveBucket } from "@/lib/storage/buckets";
import { deleteObject } from "@/lib/storage/s3";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  let body: { bucket?: unknown; path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!isFriendlyBucket(body.bucket)) {
    return NextResponse.json(
      { error: "Unknown or missing bucket." },
      { status: 400 },
    );
  }
  const path = body.path;
  if (typeof path !== "string" || !path) {
    return NextResponse.json({ error: "Missing path." }, { status: 400 });
  }

  // A caller can only delete under their own account folder — this
  // replaces the old bucket RLS write policy.
  const prefix = `account-${ctx.accountId}/`;
  if (!path.startsWith(prefix)) {
    return NextResponse.json(
      { error: "Path is outside your account." },
      { status: 403 },
    );
  }

  let realBucket: string;
  try {
    realBucket = resolveBucket(body.bucket);
  } catch (err) {
    return toErrorResponse(err);
  }

  // Best-effort: a missed delete is a storage nit, not a user error.
  try {
    await deleteObject(realBucket, path);
  } catch (err) {
    console.error("[media/delete] deleteObject failed:", err);
  }

  return NextResponse.json({ ok: true });
}

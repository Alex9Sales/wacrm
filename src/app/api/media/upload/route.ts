// ============================================================
// POST /api/media/upload — server-side media upload to MinIO/S3.
//
// The browser can't hold S3 credentials, so uploads that used to go
// straight to Supabase Storage from the client now POST a multipart
// FormData here. This route authenticates the caller, builds an
// account-scoped object key, and puts the bytes into the configured
// MinIO bucket. Both buckets are public-read, so the returned
// publicUrl is directly fetchable (Meta fetches chat/template media
// by URL).
//
// Request  (multipart/form-data):
//   file:   File   — the upload
//   bucket: string — friendly name ('avatars' | 'media')
// Response (200): { publicUrl, path }
//   401 unauthenticated · 403 no account · 400 bad input / too large
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { isFriendlyBucket, resolveBucket } from "@/lib/storage/buckets";
import { putObject, publicUrl } from "@/lib/storage/s3";

// S3 upload needs the Node runtime (AWS SDK + Buffer); not edge.
export const runtime = "nodejs";

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data." },
      { status: 400 },
    );
  }

  const bucketField = form.get("bucket");
  if (!isFriendlyBucket(bucketField)) {
    return NextResponse.json(
      { error: "Unknown or missing bucket." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty." }, { status: 400 });
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return NextResponse.json(
      { error: `File exceeds the ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB limit.` },
      { status: 400 },
    );
  }

  let realBucket: string;
  try {
    realBucket = resolveBucket(bucketField);
  } catch (err) {
    return toErrorResponse(err);
  }

  const path = buildMediaPath(ctx.accountId, file.name);
  const body = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || "application/octet-stream";

  try {
    await putObject(realBucket, path, body, contentType);
  } catch (err) {
    console.error("[media/upload] putObject failed:", err);
    return NextResponse.json({ error: "Upload failed." }, { status: 502 });
  }

  return NextResponse.json({ publicUrl: publicUrl(realBucket, path), path });
}

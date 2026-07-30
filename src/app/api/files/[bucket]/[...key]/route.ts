// ============================================================
// GET /api/files/:bucket/*key — public media proxy over the app's HTTPS.
//
// WHY: media (avatars, chat/inbound WhatsApp media) lives in MinIO and,
// left to itself, is served over plain HTTP (S3_PUBLIC_URL points at the
// MinIO host). The app runs over HTTPS, and browsers BLOCK http media on
// an https page (mixed content) — so an <img>/<audio> whose src is the
// raw MinIO http URL renders as a broken icon / dead player.
//
// This route re-serves the object THROUGH the app (same https origin),
// eliminating the mixed-content block. It's PUBLIC (no auth): both the
// browser on the inbox page AND Meta (which fetches outbound media by
// URL) must be able to reach it. The bucket path segment is whitelisted
// against the friendly bucket names, so nothing else in MinIO is exposed.
//
// The stored media_url is built by publicUrl(bucket, key) as
//   `${S3_PUBLIC_URL}/${bucket}/${key}`
// so setting S3_PUBLIC_URL to `https://<domain>/api/files` makes every
// NEW media_url resolve to `/api/files/:bucket/*key` — this route.
//
// Range requests: NOT implemented in v1. We stream the full body every
// time. <audio>/<video> playback works from a plain 200 in practice;
// seeking may re-download. A future revision can add Range support.
// ============================================================

import { NextResponse } from "next/server";
import type { Readable } from "node:stream";

import { isFriendlyBucket, resolveBucket } from "@/lib/storage/buckets";
import { getObject } from "@/lib/storage/s3";

// S3 GetObject + Node stream piping need the Node runtime, not edge.
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ bucket: string; key: string[] }>;
}

/** Fallback Content-Type by file extension when the object has none. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
};

function contentTypeForKey(key: string): string {
  const dot = key.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = key.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { bucket: bucketParam, key: keySegments } = await params;

  // Whitelist the bucket — only the friendly names are proxyable. Anything
  // else (an attempt to read an arbitrary MinIO bucket) is a 404.
  if (!isFriendlyBucket(bucketParam)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const key = (keySegments ?? []).join("/");
  if (!key) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  let realBucket: string;
  try {
    realBucket = resolveBucket(bucketParam);
  } catch {
    // Missing S3_BUCKET_* env — a server misconfig, not a client error.
    return NextResponse.json(
      { error: "Storage not configured." },
      { status: 500 },
    );
  }

  let object;
  try {
    object = await getObject(realBucket, key);
  } catch (err) {
    console.error("[files] getObject failed:", err);
    return NextResponse.json({ error: "Fetch failed." }, { status: 502 });
  }

  if (!object) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const contentType = object.contentType || contentTypeForKey(key);

  const headers = new Headers({
    "Content-Type": contentType,
    // Media objects are immutable (timestamped/UUID keys) — cache hard.
    "Cache-Control": "public, max-age=86400, immutable",
  });
  if (typeof object.contentLength === "number") {
    headers.set("Content-Length", String(object.contentLength));
  }

  // Pipe the Node Readable to the web ReadableStream the Response expects.
  const webStream = nodeToWebStream(object.body);
  return new Response(webStream, { status: 200, headers });
}

/**
 * Adapt a Node Readable (AWS SDK GetObject body) to a web ReadableStream
 * so it can be handed to the Fetch `Response`. Node ≥17 exposes
 * `Readable.toWeb`; we use it when available and fall back to a manual
 * pump otherwise.
 */
function nodeToWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  // A guarded manual pump (NOT Readable.toWeb): when the browser aborts a
  // partial download — which it does constantly for <img>/<audio> — toWeb's
  // internal pump can call enqueue on an already-closed controller and throw
  // an UNCAUGHT `ERR_INVALID_STATE: Controller is already closed`. The `closed`
  // flag + try/catch here make every controller op a no-op after teardown.
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          // Consumer gone mid-chunk — stop reading.
          closed = true;
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      nodeStream.on("error", (err) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(err);
        } catch {
          /* already torn down */
        }
      });
    },
    cancel() {
      closed = true;
      nodeStream.destroy();
    },
  });
}

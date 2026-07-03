// ============================================================
// GET /api/events — Server-Sent Events stream (Phase 3 realtime).
//
// One SSE connection per authenticated browser. It subscribes to the
// caller's account channel (`account:{accountId}`) on a DEDICATED
// ioredis connection (a subscriber connection can't be shared with
// the publisher singleton) and forwards each published event to the
// client as a `data:` frame. A comment heartbeat keeps the socket
// alive through proxies that idle-close.
//
// The client never sends over this channel — it's server → browser
// only. Consumers (use-server-events + the rewired hooks) react by
// refetching counts / bumping a resync token.
//
// Response: text/event-stream. 401 when unauthenticated.
// ============================================================

import Redis from "ioredis";

import { getCurrentAccount } from "@/lib/auth/account";
import { accountChannel } from "@/lib/events/publish";

// Never cache; must run on the Node runtime so ioredis (a TCP client)
// works — the Edge runtime has no raw sockets.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 25_000;

export async function GET(req: Request) {
  // Auth first — resolve the account BEFORE opening any stream so an
  // unauthenticated caller gets a clean 401, not a dangling socket.
  let accountId: string;
  try {
    const ctx = await getCurrentAccount();
    accountId = ctx.accountId;
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const channel = accountChannel(accountId);
  const encoder = new TextEncoder();

  let subscriber: Redis | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed (client went away between the
          // abort firing and this callback) — nothing to do.
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (subscriber) {
          // Best-effort teardown of the dedicated subscriber socket.
          subscriber.unsubscribe(channel).catch(() => {});
          subscriber.quit().catch(() => {
            subscriber?.disconnect();
          });
          subscriber = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      // Dedicated connection for subscriber mode. Reusing the shared
      // publisher would break PUBLISH for the whole process.
      const url = process.env.REDIS_URL;
      if (!url) {
        console.error("[api/events] REDIS_URL not set");
        // Still open the stream so the client gets a heartbeat and an
        // EventSource that stays "connected" rather than error-looping;
        // it just won't receive events.
      } else {
        subscriber = new Redis(url, { maxRetriesPerRequest: null });
        subscriber.on("error", (err) => {
          console.error("[api/events] subscriber error:", err.message);
        });
        subscriber.subscribe(channel).catch((err) => {
          console.error("[api/events] subscribe failed:", err);
        });
        subscriber.on("message", (ch, message) => {
          if (ch !== channel) return;
          // `message` is already a compact JSON string from publishEvent.
          enqueue(`data: ${message}\n\n`);
        });
      }

      // Prime the stream so the client's `onopen` fires promptly, then
      // heartbeat as a comment (ignored by EventSource) to defeat idle
      // proxy timeouts.
      enqueue(": connected\n\n");
      heartbeat = setInterval(() => enqueue(": ping\n\n"), HEARTBEAT_MS);

      // The browser closing the EventSource aborts the request.
      req.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      // Stream consumer went away (e.g. response body cancelled).
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (subscriber) {
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => subscriber?.disconnect());
        subscriber = null;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}

// ============================================================
// Server-only realtime event publisher (Phase 3).
//
// Ephemeral, best-effort events pushed to a per-account Redis
// pub/sub channel. The SSE endpoint (GET /api/events) subscribes to
// `account:{accountId}` on a dedicated connection and streams every
// published event to that account's connected browsers.
//
// This module owns the SHARED publisher connection. Subscribers must
// NOT reuse it — ioredis puts a connection into "subscriber mode"
// once it subscribes, after which it can no longer PUBLISH. The SSE
// route therefore creates its own connection per stream.
//
// Publishing is fire-and-forget: a Redis hiccup must never break the
// DB write that triggered the event, so every failure is swallowed
// with a console.error and never rethrown into callers.
// ============================================================

import Redis from "ioredis";

/**
 * Realtime event shapes. Ephemeral only — badges, new-message pings.
 * The client never persists these; it reacts (refetch counts / bump a
 * resync token) and moves on.
 */
export type RealtimeEvent =
  // `fromMe` marks an operator's own outgoing echo (they replied from their
  // phone) — consumers that refetch (unread) still act, but the notification
  // sound/pop-up skips it (you don't get alerted about your own reply).
  | { type: "message.received"; conversationId: string; fromMe?: boolean }
  | { type: "conversation.created"; conversationId: string }
  | {
      type: "internal_message";
      channelId: string;
      senderId?: string;
      senderName?: string;
    }
  // A WhatsApp channel's session changed state (connected/disconnected/
  // error/qr_pending). Drives the global "channel down — reconnect" banner
  // so the operator sees a drop live, without refreshing.
  | {
      type: "channel_status";
      channelId: string;
      name: string;
      status: string;
    }
  // WhatsApp voice call (Business Calling API) ringing on a Meta channel —
  // drives the incoming-call toast/ring in the CRM.
  | {
      type: "call_incoming";
      callId: string;
      from: string;
      callerName?: string;
      /** The caller's SDP offer — the browser answers it (WebRTC). */
      sdp?: string;
    }
  // A voice call ended (terminate webhook): COMPLETED | REJECTED | FAILED.
  | { type: "call_status"; callId: string; status: string }
  | { type: "notification" };

/** Channel name for an account's ephemeral event stream. */
export function accountChannel(accountId: string): string {
  return `account:${accountId}`;
}

// Lazy singleton — created on first publish, reused thereafter. Kept
// off module top-level so importing this file doesn't eagerly open a
// socket. Only server code (the SSE route + the webhook) imports this.
let publisher: Redis | null = null;

function getPublisher(): Redis | null {
  if (publisher) return publisher;

  const url = process.env.REDIS_URL;
  if (!url) {
    console.error("[events/publish] REDIS_URL is not set; events disabled");
    return null;
  }

  try {
    publisher = new Redis(url, {
      // Don't queue commands forever if Redis is unreachable — a
      // publish that can't go out immediately should just be dropped
      // rather than piling up in memory.
      maxRetriesPerRequest: 1,
      lazyConnect: false,
    });
    // A pub connection error must not crash the process. ioredis
    // reconnects on its own; we just log.
    publisher.on("error", (err) => {
      console.error("[events/publish] redis error:", err.message);
    });
  } catch (err) {
    console.error("[events/publish] failed to create publisher:", err);
    publisher = null;
    return null;
  }

  return publisher;
}

/**
 * Publish an ephemeral event to an account's channel. Best-effort:
 * returns without throwing on any failure (no Redis, serialization
 * error, publish rejection). Callers await it only to stay inside a
 * route's `after()` keep-alive window — they must never depend on its
 * success.
 */
export async function publishEvent(
  accountId: string,
  event: RealtimeEvent,
): Promise<void> {
  const redis = getPublisher();
  if (!redis) return;

  try {
    await redis.publish(accountChannel(accountId), JSON.stringify(event));
  } catch (err) {
    console.error("[events/publish] publish failed:", err);
  }
}

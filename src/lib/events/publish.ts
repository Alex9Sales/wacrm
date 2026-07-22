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
  // Someone @-mentioned one or more members. Account-wide fan-out, so it
  // carries the mentioned user ids and the listener alerts only if you're one.
  | {
      type: "mention";
      /** Where the mention lives, for the pop-up's deep link. */
      channelId?: string;
      conversationId?: string;
      senderName?: string;
      mentionedUserIds: string[];
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
  // WhatsApp voice call ringing — official Meta (carries the caller's SDP
  // offer) or unofficial waha-voip (provider:'waha'; the browser negotiates
  // its own SDP at answer time, so no sdp here). Drives the call modal.
  | {
      type: "call_incoming";
      callId: string;
      from: string;
      callerName?: string;
      /** The caller's SDP offer — Meta only; waha negotiates on accept. */
      sdp?: string;
      /** Calling transport. Absent = 'meta' (backwards compat). */
      provider?: "meta" | "waha";
      /** The WAHA channel the call rang on (routes accept/reject/webrtc). */
      channelId?: string;
      /** waha @lid callers: the raw @lid chatId (reject targets it; `from`
       *  carries the resolved real phone for display/contact). */
      callerLid?: string;
    }
  // A voice call ended (terminate webhook): COMPLETED | REJECTED | FAILED.
  | { type: "call_status"; callId: string; status: string }
  // An inbound call rings on every agent's browser; the first accept claims it
  // and this tells the other ringing modals to stand down.
  | { type: "call_claimed"; callId: string; by: string }
  // The customer answered our OUTBOUND call — carries their SDP answer for
  // the browser to setRemoteDescription and connect.
  | { type: "call_answer"; callId: string; sdp: string }
  // Live monitor of an AI voice call (Fatia 5). The bridge streams each spoken
  // line as it happens so an operator can watch the call unfold in real time.
  // phase 'start' opens the panel, 'line' appends a turn, 'end' closes it.
  | {
      type: "voice_live";
      callId: string;
      phase: "start" | "line" | "end";
      channelName?: string;
      /** The WAHA channel the AI call runs on — a human "Assumir" (handoff)
       *  needs it to claim + attach its own audio leg to the same call. */
      channelId?: string;
      from?: string;
      callerName?: string;
      /** For phase 'line': who spoke + what. */
      role?: "ai" | "customer";
      text?: string;
      /** When the turn STARTED (ms) — the monitor sorts by it so a
       *  late-arriving customer transcription lands in the right order. */
      ts?: number;
    }
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

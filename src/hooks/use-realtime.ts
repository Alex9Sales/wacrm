"use client";

import { useCallback } from "react";

import { useServerEvents, type ServerEvent } from "./use-server-events";

/**
 * Options for the generic realtime subscription.
 *
 * Phase 3 (SSE) reshape: the old Supabase-specific
 * `onMessageEvent(RealtimeEvent<Message>)` / `onConversationEvent(...)`
 * callbacks carried full postgres_changes payloads (`{ eventType, new,
 * old }`). SSE events are intentionally TINY — a type plus a
 * `conversationId` — so consumers refetch/hydrate rather than diffing a
 * row they were handed. The callbacks below therefore receive the raw
 * ephemeral event; the inbox reacts by hydrating that conversation and
 * bumping its resync token.
 */
export interface UseRealtimeOptions {
  /** Kept for call-site compatibility; not used by the SSE transport. */
  channelName?: string;
  /** Fired for `message.received` events on the account channel. */
  onMessageEvent?: (event: { type: "message.received"; conversationId?: string }) => void;
  /** Fired for `conversation.created` events on the account channel. */
  onConversationEvent?: (event: {
    type: "conversation.created";
    conversationId?: string;
  }) => void;
  /** When false, the hook still opens the stream but drops callbacks. */
  enabled?: boolean;
}

/**
 * Generic realtime subscription over SSE.
 *
 * Reimplemented on top of `useServerEvents`: it opens the per-account
 * `/api/events` stream, filters incoming events by type, and invokes
 * the matching caller callback. `isConnected` mirrors the EventSource
 * connection so callers can drive a reconnect resync (the inbox bumps
 * its resyncToken on the false → true transition). `unsubscribe` is
 * retained for API stability; the EventSource lifecycle is owned by
 * `useServerEvents` (closed on unmount), so it's a no-op.
 */
export function useRealtime(options: UseRealtimeOptions) {
  const { onMessageEvent, onConversationEvent, enabled = true } = options;

  const handler = useCallback(
    (e: ServerEvent) => {
      if (!enabled) return;
      if (e.type === "message.received") {
        onMessageEvent?.({
          type: "message.received",
          conversationId:
            typeof e.conversationId === "string" ? e.conversationId : undefined,
        });
      } else if (e.type === "conversation.created") {
        onConversationEvent?.({
          type: "conversation.created",
          conversationId:
            typeof e.conversationId === "string" ? e.conversationId : undefined,
        });
      }
    },
    [enabled, onMessageEvent, onConversationEvent],
  );

  const { isConnected } = useServerEvents(handler);

  const unsubscribe = useCallback(() => {}, []);

  return { isConnected, unsubscribe };
}

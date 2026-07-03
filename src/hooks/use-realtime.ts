"use client";

import { useCallback } from "react";
import type { Message, Conversation } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

/**
 * Generic realtime channel subscription — NEUTRALIZED in Phase 1.
 *
 * The Supabase Realtime channel (postgres_changes on messages /
 * conversations) is gone. Consumers still call this hook and read
 * `{ isConnected, unsubscribe }`, so the signature is preserved, but
 * the hook now subscribes to nothing: `isConnected` is always false
 * and `unsubscribe` is a no-op. Callers that relied on live events
 * should drive their own initial fetch + manual refetch until SSE
 * lands.
 *
 * TODO(fase-3): realtime via SSE — reintroduce the subscription and
 * flip `isConnected` / fire the onMessageEvent / onConversationEvent
 * callbacks.
 */
export function useRealtime(_options: UseRealtimeOptions) {
  // No channel to tear down; kept for API stability.
  const unsubscribe = useCallback(() => {}, []);

  // TODO(fase-3): realtime via SSE — nothing is connected in Phase 1.
  return { isConnected: false, unsubscribe };
}

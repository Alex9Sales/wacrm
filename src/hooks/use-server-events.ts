"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shape of every event that arrives over the SSE channel. `type`
 * discriminates; the rest is event-specific (e.g. `conversationId`).
 */
export interface ServerEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * Subscribe to the per-account SSE stream at `/api/events`.
 *
 * Opens an `EventSource` on mount and closes it on unmount. Each
 * `data:` frame is JSON-parsed and handed to `onEvent`. Reconnection
 * is handled natively by `EventSource` (it retries on transport
 * errors), so we don't implement our own backoff.
 *
 * Returns `{ isConnected }` reflecting the EventSource readyState —
 * `useRealtime` builds its own contract on top of this.
 *
 * v1 note: each caller of this hook opens its OWN EventSource. On a
 * page that mounts several realtime hooks that means several parallel
 * SSE connections to the same account channel. Acceptable for now
 * (the server fans out cheaply); a follow-up can hoist a single shared
 * EventSource into context and multiplex handlers off it.
 */
export function useServerEvents(onEvent: (e: ServerEvent) => void): {
  isConnected: boolean;
} {
  const [isConnected, setIsConnected] = useState(false);

  // Keep the latest callback in a ref so re-renders that pass a new
  // inline `onEvent` don't tear down and reopen the EventSource.
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    // Guard SSR / non-browser environments.
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    const es = new EventSource("/api/events");

    es.onopen = () => setIsConnected(true);

    es.onmessage = (ev) => {
      if (!ev.data) return;
      let parsed: ServerEvent;
      try {
        parsed = JSON.parse(ev.data) as ServerEvent;
      } catch {
        // Malformed frame (shouldn't happen — the server always sends
        // JSON). Ignore rather than throw into the event loop.
        return;
      }
      if (parsed && typeof parsed.type === "string") {
        handlerRef.current(parsed);
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; reflect the transient drop so
      // consumers (e.g. the inbox resync) can react to reconnects.
      setIsConnected(false);
    };

    return () => {
      es.close();
      setIsConnected(false);
    };
  }, []);

  return { isConnected };
}

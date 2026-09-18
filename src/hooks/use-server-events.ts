"use client";

import { useEffect, useRef, useState } from "react";

import {
  browserReconnectEnv,
  connectReconnectingEventSource,
} from "@/lib/realtime/reconnecting-event-source";

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
 * `data:` frame is JSON-parsed and handed to `onEvent`.
 *
 * ⚠️ Reconexão (18/09, Dra. Joyce): o EventSource do navegador desiste de vez
 * quando o servidor responde erro durante um deploy — a aba ficava sem
 * mensagem nova até recarregar. A conexão agora passa por
 * `connectReconnectingEventSource`, que reabre sozinha (ver o arquivo).
 *
 * Returns `{ isConnected }` reflecting the connection state —
 * `useRealtime` builds its own contract on top of this, and the inbox
 * resyncs on the false → true transition, so a reconnect also recovers
 * what was missed while it was down.
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
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    // Guard SSR / non-browser environments.
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    const dispose = connectReconnectingEventSource(
      "/api/events",
      {
        onOpen: () => setIsConnected(true),
        onDisconnect: () => setIsConnected(false),
        onMessage: (data) => {
          let parsed: ServerEvent;
          try {
            parsed = JSON.parse(data) as ServerEvent;
          } catch {
            // Malformed frame (shouldn't happen — the server always sends
            // JSON). Ignore rather than throw into the event loop.
            return;
          }
          if (parsed && typeof parsed.type === "string") {
            handlerRef.current(parsed);
          }
        },
      },
      browserReconnectEnv(),
    );

    return () => {
      dispose();
      setIsConnected(false);
    };
  }, []);

  return { isConnected };
}

"use client";

import { useCallback, useEffect, useState } from "react";

import { useServerEvents } from "./use-server-events";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Phase 3: initial value comes from GET /api/conversations/unread-count,
 * then the count is refetched whenever an SSE `message.received` event
 * lands on the account channel (a new inbound message may have changed
 * which conversations are unread). Window-focus refresh is kept as a
 * cheap fallback for events missed while the SSE socket was down.
 *
 * Returns a bare `number` (unchanged shape) so the sidebar keeps
 * typechecking.
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations/unread-count", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { count: number };
      setTotal(body.count ?? 0);
    } catch (err) {
      console.error("[useTotalUnread] fetch failed:", err);
    }
  }, []);

  // Live: an inbound message can flip a conversation to unread. Refetch
  // the derived count rather than mirroring it locally — the count is a
  // DISTINCT-conversations aggregate, not a simple +1.
  useServerEvents(
    useCallback(
      (e) => {
        if (e.type === "message.received") void refetch();
      },
      [refetch],
    ),
  );

  useEffect(() => {
    void refetch();
    // Focus fallback so the badge isn't stale after events missed while
    // the SSE connection was interrupted (sleep, network blip).
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return total;
}

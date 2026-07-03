"use client";

import { useCallback, useEffect, useState } from "react";

import { useServerEvents } from "./use-server-events";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * Phase 3: initial value comes from GET /api/notifications/unread-count,
 * then the count is refetched on an SSE `notification` event. As a
 * pragmatic fallback we also refetch on `message.received` — an inbound
 * message is the most common trigger for a new notification, and no
 * server path emits a dedicated `notification` event yet. Window-focus
 * refresh covers events missed while the socket was down.
 *
 * Returns a bare `number` (unchanged shape) so the sidebar keeps
 * typechecking.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { count: number };
      setCount(body.count ?? 0);
    } catch (err) {
      console.error("[useUnreadNotifications] fetch failed:", err);
    }
  }, []);

  useServerEvents(
    useCallback(
      (e) => {
        if (e.type === "notification" || e.type === "message.received") {
          void refetch();
        }
      },
      [refetch],
    ),
  );

  useEffect(() => {
    void refetch();
    // Focus fallback so the badge isn't stale after events missed while
    // the SSE connection was interrupted.
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return count;
}

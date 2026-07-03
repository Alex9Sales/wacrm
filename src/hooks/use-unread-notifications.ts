"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * Phase 1: the Supabase Realtime channel is gone. The count is fetched
 * once from GET /api/notifications/unread-count and refreshed when the
 * tab regains focus, instead of ticking live off postgres_changes.
 *
 * Returns a bare `number` (unchanged shape) so the sidebar keeps
 * typechecking.
 *
 * TODO(fase-3): live updates via SSE — restore the incremental
 * INSERT/UPDATE/DELETE accounting so the badge moves without a
 * refetch.
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

  useEffect(() => {
    void refetch();
    // Refresh on focus so the badge isn't permanently stale between
    // page views while realtime is deferred.
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return count;
}

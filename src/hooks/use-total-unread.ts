"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Count of conversations with at least one unread inbound message for
 * the current user. Used by the sidebar to surface a green dot on the
 * Inbox nav entry when the user is elsewhere in the app.
 *
 * Phase 1: the Supabase Realtime channel is gone. The count is fetched
 * once from GET /api/conversations/unread-count and refreshed when the
 * tab regains focus, instead of ticking live off postgres_changes.
 *
 * Returns a bare `number` (unchanged shape) so the sidebar keeps
 * typechecking.
 *
 * TODO(fase-3): live updates via SSE — restore the O(1) local mirror
 * that adjusts the total on each INSERT/UPDATE/DELETE without a
 * refetch.
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

  useEffect(() => {
    void refetch();
    // Refresh on focus so the badge isn't permanently stale between
    // page views while realtime is deferred.
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  return total;
}

"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Count of OPEN tasks that need attention (overdue + due today) for
 * the current account. Powers the red badge on the sidebar's
 * "Tarefas" entry.
 *
 * Kept lightweight: fetches once on mount, refetches on window focus,
 * and polls on a slow interval (60s) so the badge stays roughly fresh
 * without hammering the endpoint. There's no SSE `task` event yet —
 * when one lands (next waves), swap the interval for an event refetch.
 *
 * Returns a bare `number` so the sidebar keeps typechecking.
 */
export function useTasksDueAlert(): number {
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks/due-alert", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { count: number };
      setCount(body.count ?? 0);
    } catch (err) {
      console.error("[useTasksDueAlert] fetch failed:", err);
    }
  }, []);

  useEffect(() => {
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    // Slow poll — the alert is a badge, not a live counter.
    const id = window.setInterval(() => void refetch(), 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(id);
    };
  }, [refetch]);

  return count;
}

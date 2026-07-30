"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  derivePresence,
  HEARTBEAT_MS,
  type PresenceRow,
  type PresenceStatus,
} from "@/lib/presence";

interface UsePresenceResult {
  /** Derived status for one member (offline if unseen / stale). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /** The clock the hook is deriving against — pass to presenceLabel so
   *  labels stay in lockstep with the dots. */
  now: number;
}

/**
 * Live presence for every member of the caller's account (Fase 3).
 *
 * Fetches the account's presence rows from GET /api/presence, polls to stay
 * fresh, and re-derives every few seconds so a member whose heartbeat went
 * stale flips to "offline" without a refetch. Reporting is done by
 * <PresenceHeartbeat/>. No SSE yet — a poll is plenty for a presence dot.
 */
export function usePresence(enabled = true): UsePresenceResult {
  const [rows, setRows] = useState<Map<string, PresenceRow>>(new Map());
  // `now` advances on a slow tick so derivePresence re-runs and stale rows
  // decay to offline between fetches.
  const [now, setNow] = useState(() => Date.now());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const refetch = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const res = await fetch("/api/presence", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as {
        presence: { user_id: string; status: string; last_seen_at: string }[];
      };
      const map = new Map<string, PresenceRow>();
      for (const p of body.presence ?? []) {
        map.set(p.user_id, {
          status: p.status === "away" ? "away" : "online",
          last_seen_at: p.last_seen_at,
        });
      }
      setRows(map);
      setNow(Date.now());
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    // Poll for others' presence roughly in step with the heartbeat cadence.
    const poll = window.setInterval(() => void refetch(), HEARTBEAT_MS);
    // Faster re-derive tick so a member who stopped heartbeating decays to
    // offline promptly (without hammering the network).
    const tick = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [enabled, refetch]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}

"use client";

import { useCallback, useState } from "react";

import { derivePresence, type PresenceRow, type PresenceStatus } from "@/lib/presence";

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots.
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account —
 * NEUTRALIZED in Phase 1.
 *
 * Presence (the `member_presence` table + Realtime channel) is being
 * removed in Phase 1 per the migration plan. This hook now holds no
 * rows and never subscribes: every member reads back as offline and
 * `getRow` returns undefined. The signature is preserved so consumer
 * components still typecheck.
 *
 * TODO(fase-3): presence returns with SSE. When it does, restore the
 * initial fetch + subscription and the ~15s re-derive tick.
 */
export function usePresence(_enabled = true): UsePresenceResult {
  // `now` is captured once; with no rows the derived status is always
  // offline regardless, so we don't need the re-derive interval.
  const [now] = useState(() => Date.now());

  const getRow = useCallback((_userId: string): PresenceRow | undefined => {
    return undefined;
  }, []);

  const getPresence = useCallback(
    (_userId: string): PresenceStatus => derivePresence(undefined, undefined, now),
    [now],
  );

  return { getPresence, getRow, now };
}

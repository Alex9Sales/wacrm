"use client";

/**
 * PresenceHeartbeat — headless, NEUTRALIZED in Phase 1.
 *
 * Presence (the `member_presence` table + the `touch_presence` RPC)
 * is being removed in Phase 1 per the migration plan, so this tab no
 * longer reports its presence. The component is still mounted once in
 * the dashboard shell; it just renders nothing and does no work.
 *
 * TODO(fase-3): presence returns with SSE — restore the heartbeat
 * loop (online/away detection + periodic report) at that point.
 */
export function PresenceHeartbeat() {
  return null;
}

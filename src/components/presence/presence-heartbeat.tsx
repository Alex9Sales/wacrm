"use client";

// PresenceHeartbeat — headless. The SINGLE writer of this tab's presence to
// /api/presence, so teammates see who's around. Mounted once in the shell.
//
// Since Fase 3.1 presence is MANUAL: the member picks Online / Ausente /
// Offline in the header control (see use-my-status). This component just keeps
// the DB row fresh with whatever they chose:
//   • reports the chosen status on mount and whenever it changes (snappy for
//     other viewers), and
//   • re-reports every HEARTBEAT_MS so the row never goes stale while the tab
//     is open — a closed tab stops beating and derives to offline on its own.

import { useEffect } from "react";

import { HEARTBEAT_MS, type StoredPresence } from "@/lib/presence";
import { useMyStatus } from "@/hooks/use-my-status";

async function report(status: StoredPresence) {
  try {
    await fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
      keepalive: true,
    });
  } catch {
    // Best-effort — a dropped heartbeat just makes this tab look offline
    // sooner; the next beat recovers it.
  }
}

export function PresenceHeartbeat() {
  const { status } = useMyStatus();

  useEffect(() => {
    void report(status); // immediate on mount + on every status change
    const interval = window.setInterval(() => void report(status), HEARTBEAT_MS);
    return () => window.clearInterval(interval);
  }, [status]);

  return null;
}

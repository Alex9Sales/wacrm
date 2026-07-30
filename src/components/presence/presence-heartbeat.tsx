"use client";

// PresenceHeartbeat — headless. Reports THIS tab's presence (online / away) so
// teammates see who's around. Mounted once in the dashboard shell.
//
//  • Reports 'online' on mount, then every HEARTBEAT_MS.
//  • Flips to 'away' after IDLE_AFTER_MS with no input, or while the tab is
//    hidden; back to 'online' on any activity / re-focus (reported promptly).
//  • Never reports 'offline' — that's derived from staleness (a closed tab
//    stops heartbeating and its row goes stale → offline). See lib/presence.ts.

import { useEffect, useRef } from "react";

import { HEARTBEAT_MS, IDLE_AFTER_MS } from "@/lib/presence";

async function report(status: "online" | "away") {
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
  const lastActivityRef = useRef<number>(Date.now());

  useEffect(() => {
    const bump = () => {
      lastActivityRef.current = Date.now();
    };
    const events = ["mousedown", "keydown", "mousemove", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));

    const currentStatus = (): "online" | "away" => {
      if (document.hidden) return "away";
      return Date.now() - lastActivityRef.current > IDLE_AFTER_MS
        ? "away"
        : "online";
    };

    const beat = () => void report(currentStatus());

    beat(); // initial
    const interval = window.setInterval(beat, HEARTBEAT_MS);

    // React promptly to focus/visibility changes (don't wait for the tick).
    const onVisibility = () => {
      if (!document.hidden) lastActivityRef.current = Date.now();
      beat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);

    return () => {
      window.clearInterval(interval);
      events.forEach((e) => window.removeEventListener(e, bump));
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  return null;
}

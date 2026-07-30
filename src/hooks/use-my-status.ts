"use client";

// My own presence status (Fase 3.1) — MANUAL.
//
// The member picks their status from the header control (Online / Ausente /
// Offline). This is a tiny app-wide store so every consumer stays in lockstep:
//   • the header control (reads + writes),
//   • <PresenceHeartbeat/> (the single writer to /api/presence), and
//   • the inbox composer (blocks replying while away/offline).
//
// Persisted in localStorage so the choice survives reloads, and mirrored
// across tabs via the `storage` event — set yourself Offline in one tab and
// every tab agrees.

import { useCallback, useEffect, useState } from "react";

import type { StoredPresence } from "@/lib/presence";

const STORAGE_KEY = "fluxia:presence-status";
const CHANGE_EVENT = "fluxia:presence-status-changed";

function isStatus(v: unknown): v is StoredPresence {
  return v === "online" || v === "away" || v === "offline";
}

/** Module-level current value so all hook instances share one source. */
let current: StoredPresence = "online";
if (typeof window !== "undefined") {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (isStatus(stored)) current = stored;
}

/** Read the current manual status without subscribing (for one-off checks). */
export function getMyStatus(): StoredPresence {
  return current;
}

interface UseMyStatusResult {
  status: StoredPresence;
  setStatus: (next: StoredPresence) => void;
}

export function useMyStatus(): UseMyStatusResult {
  const [status, setStatusState] = useState<StoredPresence>(current);

  useEffect(() => {
    // Same-tab updates from other consumers.
    const onChange = () => setStatusState(current);
    window.addEventListener(CHANGE_EVENT, onChange);
    // Cross-tab: another tab wrote the key.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isStatus(e.newValue)) {
        current = e.newValue;
        setStatusState(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    // Re-sync in case the module value changed before this effect ran.
    if (current !== status) setStatusState(current);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = useCallback((next: StoredPresence) => {
    if (next === current) return;
    current = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / quota — the in-memory value still drives the session */
    }
    // Notify same-tab consumers (storage event only fires in OTHER tabs).
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { status, setStatus };
}

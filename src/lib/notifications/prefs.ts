"use client";

// Per-device notification preferences (sound + pop-up). Stored in
// localStorage — they control how THIS browser alerts, so they don't belong on
// the account/server. A tiny event lets the settings panel and the global
// listener stay in sync without a shared store.

import { DEFAULT_SOUND_ID } from "./sounds";

export interface NotificationPrefs {
  soundEnabled: boolean;
  soundId: string;
  volume: number; // 0..1
  toastEnabled: boolean;
}

const KEY = "fluxia.notifications.v1";
const EVENT = "fluxia:notification-prefs";

export const DEFAULT_PREFS: NotificationPrefs = {
  soundEnabled: true,
  soundId: DEFAULT_SOUND_ID,
  volume: 0.8,
  toastEnabled: true,
};

export function getNotificationPrefs(): NotificationPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function setNotificationPrefs(patch: Partial<NotificationPrefs>): NotificationPrefs {
  const next = { ...getNotificationPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // storage disabled — keep the in-memory value for this session only
  }
  return next;
}

/** Subscribe to pref changes (same-tab custom event + cross-tab storage). */
export function onNotificationPrefsChange(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

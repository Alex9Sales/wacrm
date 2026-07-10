"use client";

// ============================================================
// Notification sounds — short tones synthesized with the Web Audio API, so
// there are no binary assets to ship and they stay crisp at any volume. Each
// sound is a small sequence of notes. Playing lazily (re)creates/resumes a
// shared AudioContext — safe to call from an SSE handler because the user has
// already interacted with the app by then.
// ============================================================

export interface NotificationSound {
  id: string;
  label: string;
}

export const NOTIFICATION_SOUNDS: NotificationSound[] = [
  { id: "toque", label: "Toque" },
  { id: "pop", label: "Pop" },
  { id: "sino", label: "Sino" },
  { id: "alerta", label: "Alerta" },
];

export const DEFAULT_SOUND_ID = "toque";

interface Note {
  freq: number;
  /** seconds from the start of the sound */
  at: number;
  /** seconds */
  dur: number;
  type?: OscillatorType;
  /** peak gain 0..1 */
  gain?: number;
}

// Each sound as a tiny note sequence. Kept short (< 0.5s) and gentle.
const RECIPES: Record<string, Note[]> = {
  toque: [{ freq: 880, at: 0, dur: 0.18, type: "sine", gain: 0.5 }],
  pop: [{ freq: 520, at: 0, dur: 0.09, type: "triangle", gain: 0.6 }],
  sino: [
    { freq: 784, at: 0, dur: 0.28, type: "sine", gain: 0.45 },
    { freq: 1175, at: 0.09, dur: 0.32, type: "sine", gain: 0.35 },
  ],
  alerta: [
    { freq: 440, at: 0, dur: 0.12, type: "square", gain: 0.28 },
    { freq: 660, at: 0.14, dur: 0.14, type: "square", gain: 0.28 },
  ],
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Play a notification sound by id. `volume` is 0..1 (default 0.8). No-op on
 *  failure (autoplay blocked, unsupported) — a sound must never throw. */
export function playNotificationSound(id: string, volume = 0.8): void {
  const audio = getCtx();
  if (!audio) return;
  const notes = RECIPES[id] ?? RECIPES[DEFAULT_SOUND_ID];
  const t0 = audio.currentTime;
  const vol = Math.max(0, Math.min(1, volume));
  for (const n of notes) {
    try {
      const osc = audio.createOscillator();
      const gainNode = audio.createGain();
      osc.type = n.type ?? "sine";
      osc.frequency.value = n.freq;
      const peak = (n.gain ?? 0.5) * vol;
      const start = t0 + n.at;
      const end = start + n.dur;
      gainNode.gain.setValueAtTime(0.0001, start);
      gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.012);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gainNode).connect(audio.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    } catch {
      // ignore a single failed note
    }
  }
}

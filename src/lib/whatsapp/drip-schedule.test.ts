import { describe, it, expect } from 'vitest';
import {
  computeDripSlots,
  normalizePacing,
  localWeekday,
  localMinuteOfDay,
  pacingIntervalMinutes,
  nowSpacedSlots,
  inferSpacingMs,
  reslotPendingSlots,
  countSentToday,
  DEFAULT_PACING,
  type PacingConfig,
} from './drip-schedule';

// Campo Grande, 08–18h, Mon–Sat, 50/day.
const CFG: PacingConfig = { ...DEFAULT_PACING };

// A known Monday 09:00 local (Campo Grande, UTC-4) → 13:00 UTC.
// 2026-07-06 is a Monday.
const MON_9H_LOCAL_UTC = Date.parse('2026-07-06T13:00:00.000Z');

function allInWindow(slots: number[], cfg: PacingConfig): boolean {
  return slots.every((s) => {
    const m = localMinuteOfDay(s, cfg.offsetMin);
    const wd = localWeekday(s, cfg.offsetMin);
    return m >= cfg.startMin && m <= cfg.endMin && cfg.days.includes(wd);
  });
}

function strictlyIncreasing(slots: number[]): boolean {
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) return false;
  return true;
}

/** Count slots per local calendar day. */
function perDayCounts(slots: number[], offsetMin: number): number[] {
  const byDay = new Map<number, number>();
  for (const s of slots) {
    const dayIdx = Math.floor((s + offsetMin * 60_000) / 86_400_000);
    byDay.set(dayIdx, (byDay.get(dayIdx) ?? 0) + 1);
  }
  return [...byDay.values()];
}

describe('computeDripSlots', () => {
  it('returns nothing for a non-positive count', () => {
    expect(computeDripSlots(0, CFG, MON_9H_LOCAL_UTC)).toEqual([]);
    expect(computeDripSlots(-5, CFG, MON_9H_LOCAL_UTC)).toEqual([]);
  });

  it('spreads fewer-than-cap recipients across the same day', () => {
    const slots = computeDripSlots(10, CFG, MON_9H_LOCAL_UTC);
    expect(slots).toHaveLength(10);
    expect(strictlyIncreasing(slots)).toBe(true);
    expect(allInWindow(slots, CFG)).toBe(true);
    // All 10 fit today (Monday) since we start at 09:00 and 10 hourly-ish
    // slots fit before 18:00.
    expect(perDayCounts(slots, CFG.offsetMin)).toEqual([10]);
  });

  it('never schedules a past slot (first slot is after now)', () => {
    const slots = computeDripSlots(10, CFG, MON_9H_LOCAL_UTC);
    expect(slots[0]).toBeGreaterThan(MON_9H_LOCAL_UTC);
  });

  it('caps at dailyCap per day and rolls the rest to following days', () => {
    // 120 recipients, cap 50 → today (partial, started 09:00) + next days.
    const slots = computeDripSlots(120, CFG, MON_9H_LOCAL_UTC);
    expect(slots).toHaveLength(120);
    expect(strictlyIncreasing(slots)).toBe(true);
    expect(allInWindow(slots, CFG)).toBe(true);
    for (const n of perDayCounts(slots, CFG.offsetMin)) {
      expect(n).toBeLessThanOrEqual(CFG.dailyCap);
    }
  });

  it('skips Sundays', () => {
    // 200 recipients over several days must touch a Sunday span but place none.
    const slots = computeDripSlots(200, CFG, MON_9H_LOCAL_UTC);
    for (const s of slots) {
      expect(localWeekday(s, CFG.offsetMin)).not.toBe(0); // 0 = Sunday
    }
  });

  it('starts on the next allowed day when created after the window', () => {
    // Saturday 20:00 local → 2026-07-11 is a Saturday; 20:00 local = 00:00 UTC Sun.
    const satEvening = Date.parse('2026-07-12T00:00:00.000Z'); // Sat 20:00 Campo Grande
    const slots = computeDripSlots(3, CFG, satEvening);
    expect(slots).toHaveLength(3);
    // Saturday's window is over and Sunday is skipped → first slot is Monday.
    expect(localWeekday(slots[0], CFG.offsetMin)).toBe(1); // Monday
    expect(allInWindow(slots, CFG)).toBe(true);
  });

  it('places the first slot at the window start on a fresh allowed day', () => {
    // Monday 06:00 local (before window opens) → 10:00 UTC.
    const monEarly = Date.parse('2026-07-06T10:00:00.000Z');
    const slots = computeDripSlots(5, CFG, monEarly);
    expect(localMinuteOfDay(slots[0], CFG.offsetMin)).toBe(CFG.startMin); // 08:00
  });
});

describe('pacingIntervalMinutes', () => {
  it('splits the window across the daily cap', () => {
    expect(pacingIntervalMinutes(CFG)).toBe(12); // 600 / 50
    expect(pacingIntervalMinutes({ ...CFG, dailyCap: 20 })).toBe(30); // 600 / 20
    expect(pacingIntervalMinutes({ ...CFG, dailyCap: 10000 })).toBe(1); // floored at 1
  });
});

describe('nowSpacedSlots', () => {
  it('spaces from now by the interval', () => {
    const now = 1_000_000
    expect(nowSpacedSlots(3, 60_000, now)).toEqual([now, now + 60_000, now + 120_000]);
  });
  it('bursts (all at now) when interval is 0', () => {
    const now = 5_000
    expect(nowSpacedSlots(3, 0, now)).toEqual([now, now, now]);
  });
  it('returns empty for zero count', () => {
    expect(nowSpacedSlots(0, 1000, 5)).toEqual([]);
  });
});

describe('normalizePacing', () => {
  it('fills defaults and clamps bad values', () => {
    expect(normalizePacing(null)).toEqual(DEFAULT_PACING);
    expect(normalizePacing({ dailyCap: 0 }).dailyCap).toBe(DEFAULT_PACING.dailyCap);
    expect(normalizePacing({ dailyCap: 5000 }).dailyCap).toBe(2000);
    expect(normalizePacing({ endMin: 100, startMin: 200 }).endMin).toBe(DEFAULT_PACING.endMin);
    expect(normalizePacing({ days: [7, 8, 2] }).days).toEqual([2]);
    expect(normalizePacing({ days: [] }).days).toEqual(DEFAULT_PACING.days);
  });

  it('keeps a valid custom config', () => {
    const cfg = normalizePacing({ dailyCap: 30, startMin: 540, endMin: 1140, days: [1, 2, 3, 4, 5], offsetMin: -180 });
    expect(cfg).toEqual({ dailyCap: 30, startMin: 540, endMin: 1140, days: [1, 2, 3, 4, 5], offsetMin: -180 });
  });
});

// 15/09 (GoLink): retomar um disparo pausado soltava a fila vencida de uma vez.
describe('inferSpacingMs + reslotPendingSlots', () => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 8, 15, 12, 50, 0);

  it('deduz o intervalo do "Enviar agora" pelos horários gravados', () => {
    const slots = Array.from({ length: 45 }, (_, i) => T0 + i * 2 * MIN);
    expect(inferSpacingMs(slots)).toBe(2 * MIN);
    expect(inferSpacingMs([T0, T0, T0, null])).toBe(0);
    expect(inferSpacingMs([null, undefined])).toBe(0);
    // um reagendado fora do compasso não muda a mediana
    expect(inferSpacingMs([...slots, T0 + 7 * MIN + 13_000])).toBe(2 * MIN);
  });

  it('retomar depois de uma pausa longa NÃO despeja: 1 a cada 2 min a partir de agora', () => {
    const now = T0 + 33 * MIN; // pausado das 09:52 às 10:23 SP
    const lastSent = T0 + 2 * MIN;
    const next = reslotPendingSlots({ pendingCount: 43, pacing: null, spacingMs: 2 * MIN, lastSentAtMs: lastSent, nowMs: now })!;
    expect(next).toHaveLength(43);
    expect(next[0]).toBe(now);
    for (let i = 1; i < next.length; i++) expect(next[i] - next[i - 1]).toBe(2 * MIN);
  });

  it('pausa curta: o 1º espera completar o intervalo desde o último envio', () => {
    const lastSent = T0;
    const now = T0 + 30_000;
    const next = reslotPendingSlots({ pendingCount: 3, pacing: null, spacingMs: 2 * MIN, lastSentAtMs: lastSent, nowMs: now })!;
    expect(next[0]).toBe(T0 + 2 * MIN);
  });

  it('rajada escolhida (intervalo 0) fica como está', () => {
    expect(reslotPendingSlots({ pendingCount: 5, pacing: null, spacingMs: 0, lastSentAtMs: null, nowMs: T0 })).toBeNull();
  });

  // Revisão 15/09: retomar o gotejamento às 17h espremia 50 envios até as 18h.
  it('gotejamento retomado no fim do dia respeita o limite do dia e o passo', () => {
    const step = pacingIntervalMinutes(CFG) * MIN; // 12 min
    const now = MON_9H_LOCAL_UTC + 8 * 60 * MIN + 5 * MIN; // segunda 17:05 (Campo Grande)
    const next = reslotPendingSlots({ pendingCount: 155, pacing: CFG, spacingMs: step, lastSentAtMs: now - 3 * MIN, nowMs: now, usedToday: 45 })!;
    expect(next).toHaveLength(155);
    const monday = next.filter((t) => localWeekday(t, CFG.offsetMin) === 1 && t - now < 86_400_000);
    expect(monday.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < next.length; i++) expect(next[i] - next[i - 1]).toBeGreaterThanOrEqual(step);
    expect(allInWindow(next, CFG)).toBe(true);
    expect(Math.max(...perDayCounts(next, CFG.offsetMin))).toBeLessThanOrEqual(CFG.dailyCap);
  });

  it('gotejamento retomado 10 s depois de um envio espera o passo inteiro', () => {
    const step = pacingIntervalMinutes(CFG) * MIN;
    const lastSent = MON_9H_LOCAL_UTC;
    const next = reslotPendingSlots({ pendingCount: 3, pacing: CFG, spacingMs: step, lastSentAtMs: lastSent, nowMs: lastSent + 10_000, usedToday: 1 })!;
    expect(next[0] - lastSent).toBeGreaterThanOrEqual(step);
  });

  it('gotejamento retomado mantém o máximo por dia mesmo sem divisão exata (48/dia)', () => {
    const cfg48 = { ...CFG, dailyCap: 48 };
    const sunday = MON_9H_LOCAL_UTC - 86_400_000; // domingo: começa na segunda
    const next = reslotPendingSlots({ pendingCount: 96, pacing: cfg48, spacingMs: 0, lastSentAtMs: null, nowMs: sunday, usedToday: 0 })!;
    expect(next).toHaveLength(96);
    expect(perDayCounts(next, CFG.offsetMin)).toEqual([48, 48]);
  });

  it('máximo 1 por dia com 100 pendentes: agenda todos (sem cortar)', () => {
    const cfg1 = { ...CFG, dailyCap: 1 };
    const next = reslotPendingSlots({ pendingCount: 100, pacing: cfg1, spacingMs: 0, lastSentAtMs: null, nowMs: MON_9H_LOCAL_UTC, usedToday: 0 })!;
    expect(next).toHaveLength(100);
    expect(computeDripSlots(100, cfg1, MON_9H_LOCAL_UTC)).toHaveLength(100);
  });

  it('countSentToday conta pelo dia local', () => {
    const now = MON_9H_LOCAL_UTC;
    expect(countSentToday([now - MIN, now - 60 * MIN, now - 86_400_000], now, CFG.offsetMin)).toBe(2);
  });
});

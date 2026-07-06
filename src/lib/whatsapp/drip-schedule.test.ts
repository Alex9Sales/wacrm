import { describe, it, expect } from 'vitest';
import {
  computeDripSlots,
  normalizePacing,
  localWeekday,
  localMinuteOfDay,
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

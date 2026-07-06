// ============================================================
// Humanized drip scheduling — compute a send instant for each recipient
// of a "text" broadcast so sends are spread evenly across business hours,
// capped per day, and never fall outside allowed weekdays.
//
// This is the RecebAI-style pacing: you drop in all contacts, and the
// system trickles them out — at most `dailyCap` per day, one every
// `window / dailyCap` minutes, only within [startMin, endMin] local time,
// only on allowed weekdays. Overflow rolls to the next allowed day.
//
// Pure + timezone-explicit (fixed UTC offset, no DST — Campo Grande is
// UTC-4 year round). Times are computed by shifting UTC into "local ms"
// (utc + offset), doing all day/window math there, then shifting back.
// ============================================================

export interface PacingConfig {
  /** Max messages sent per allowed day. */
  dailyCap: number;
  /** Business window start, minutes since local midnight (08:00 = 480). */
  startMin: number;
  /** Business window end, minutes since local midnight (18:00 = 1080). */
  endMin: number;
  /** Allowed weekdays, 0=Sun … 6=Sat (Mon–Sat = [1,2,3,4,5,6]). */
  days: number[];
  /** Local timezone offset from UTC in minutes (Campo Grande = -240). */
  offsetMin: number;
}

/** Campo Grande (UTC-4), 08h–18h, Mon–Sat, 50/day. */
export const DEFAULT_PACING: PacingConfig = {
  dailyCap: 50,
  startMin: 8 * 60,
  endMin: 18 * 60,
  days: [1, 2, 3, 4, 5, 6],
  offsetMin: -240,
};

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** Normalize + clamp a caller-supplied pacing config to sane bounds. */
export function normalizePacing(input: Partial<PacingConfig> | null | undefined): PacingConfig {
  const p = { ...DEFAULT_PACING, ...(input ?? {}) };
  let dailyCap = Math.floor(Number(p.dailyCap));
  if (!Number.isFinite(dailyCap) || dailyCap < 1) dailyCap = DEFAULT_PACING.dailyCap;
  dailyCap = Math.min(dailyCap, 2000); // safety ceiling
  let startMin = Math.floor(Number(p.startMin));
  let endMin = Math.floor(Number(p.endMin));
  if (!Number.isFinite(startMin) || startMin < 0 || startMin > 1439) startMin = DEFAULT_PACING.startMin;
  if (!Number.isFinite(endMin) || endMin <= startMin || endMin > 1440) endMin = DEFAULT_PACING.endMin;
  const days = Array.isArray(p.days)
    ? [...new Set(p.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    : DEFAULT_PACING.days;
  const offsetMin = Number.isFinite(Number(p.offsetMin)) ? Math.floor(Number(p.offsetMin)) : DEFAULT_PACING.offsetMin;
  return {
    dailyCap,
    startMin,
    endMin,
    days: days.length ? days : DEFAULT_PACING.days,
    offsetMin,
  };
}

/** The humanized interval (minutes) between sends implied by a pacing
 *  config: the business window split across the daily cap. */
export function pacingIntervalMinutes(cfg: PacingConfig): number {
  return Math.max(1, Math.round((cfg.endMin - cfg.startMin) / cfg.dailyCap));
}

/**
 * Slots for a "send now, but spaced" run: the first at `nowMs`, then one
 * every `intervalMs`. No business-hours / daily-cap gating — the caller
 * chose to send immediately. `intervalMs <= 0` → everything at once (burst).
 */
export function nowSpacedSlots(
  count: number,
  intervalMs: number,
  nowMs: number,
): number[] {
  const step = intervalMs > 0 ? intervalMs : 0;
  const slots: number[] = [];
  for (let i = 0; i < count; i++) slots.push(nowMs + i * step);
  return slots;
}

/** Local weekday (0-6) for a UTC instant under the given offset. */
export function localWeekday(utcMs: number, offsetMin: number): number {
  return new Date(utcMs + offsetMin * MIN_MS).getUTCDay();
}

/** Local minute-of-day (0-1439) for a UTC instant under the given offset. */
export function localMinuteOfDay(utcMs: number, offsetMin: number): number {
  const local = new Date(utcMs + offsetMin * MIN_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/**
 * Compute the ordered send instants (epoch ms, UTC) for `count` recipients.
 *
 * Each returned instant is inside the business window and on an allowed
 * weekday. At most `dailyCap` land on any day, spaced `window/dailyCap`
 * minutes apart (or `window/count` when fewer than a full day's worth
 * remain). The first day only uses slots at/after `nowMs` (+1 min buffer);
 * everything past a day's window rolls to the next allowed day.
 */
export function computeDripSlots(
  count: number,
  cfg: PacingConfig,
  nowMs: number,
): number[] {
  const slots: number[] = [];
  if (count <= 0) return slots;
  const { dailyCap, startMin, endMin, days, offsetMin } = cfg;

  const localNow = nowMs + offsetMin * MIN_MS;
  let dayStartLocal = Math.floor(localNow / DAY_MS) * DAY_MS; // local midnight (local ms)

  let remaining = count;
  let first = true;
  // Guard against a pathological infinite loop: enough days to place all
  // recipients at 1/day, plus a week of skipped days, plus slack.
  let safety = count + 14;

  while (remaining > 0 && safety-- > 0) {
    const weekday = new Date(dayStartLocal).getUTCDay();
    if (days.includes(weekday)) {
      const windowStartLocal = dayStartLocal + startMin * MIN_MS;
      const windowEndLocal = dayStartLocal + endMin * MIN_MS;

      // On the current day, don't schedule slots already in the past.
      let earliest = windowStartLocal;
      if (first && localNow > windowStartLocal) earliest = localNow + MIN_MS;

      if (earliest < windowEndLocal) {
        const dayCount = Math.min(remaining, dailyCap);
        // Spread this day's batch across the REMAINING window [earliest, end)
        // so a mid-day start still fits its whole batch today. On a fresh day
        // earliest == windowStart, giving even window/dayCount spacing.
        const effSpanMs = windowEndLocal - earliest;
        const stepMs = effSpanMs / dayCount;
        for (let i = 0; i < dayCount && remaining > 0; i++) {
          const slotLocal = earliest + Math.round(i * stepMs);
          if (slotLocal >= windowEndLocal) break;
          slots.push(slotLocal - offsetMin * MIN_MS); // local ms → UTC ms
          remaining--;
        }
      }
    }
    first = false;
    dayStartLocal += DAY_MS;
  }

  return slots;
}

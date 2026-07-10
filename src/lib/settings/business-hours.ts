// ============================================================
// Business-hours evaluation — is `now` inside the account's opening window?
// Pure + timezone-aware (Intl), so the worker and the inbound pipeline agree.
// ============================================================

import type { AccountSettings, BusinessDay } from './account-settings'

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** "HH:MM" → minutes since midnight, or null if malformed. */
function toMinutes(hhmm: string | null): number | null {
  if (!hhmm) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

/** The weekday index (0=Sun) and minutes-since-midnight of `date` in `tz`. */
function localParts(date: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  let day = 0
  let hour = 0
  let minute = 0
  for (const p of parts) {
    if (p.type === 'weekday') day = WEEKDAY_INDEX[p.value] ?? 0
    else if (p.type === 'hour') hour = Number(p.value) % 24
    else if (p.type === 'minute') minute = Number(p.value)
  }
  return { day, minutes: hour * 60 + minute }
}

/**
 * True when `now` falls inside the account's configured opening window. If
 * business hours are disabled it returns true (nothing is gated). A day with
 * no open/close (or malformed times) is treated as closed. An overnight
 * window (close <= open, e.g. 18:00→02:00) wraps past midnight.
 */
export function isWithinBusinessHours(
  settings: Pick<
    AccountSettings,
    'businessHoursEnabled' | 'businessDays' | 'businessTimezone'
  >,
  now: Date = new Date(),
): boolean {
  if (!settings.businessHoursEnabled) return true
  const tz = settings.businessTimezone || 'America/Campo_Grande'
  let day: number
  let minutes: number
  try {
    ;({ day, minutes } = localParts(now, tz))
  } catch {
    // Bad timezone string → fail open (treat as within hours, never block).
    return true
  }
  const days = settings.businessDays ?? []
  const today: BusinessDay | undefined = days[day]
  if (today) {
    const open = toMinutes(today.open)
    const close = toMinutes(today.close)
    if (open != null && close != null) {
      if (close > open) {
        if (minutes >= open && minutes < close) return true
      } else if (close < open) {
        // Overnight window wrapping past midnight (open..24:00).
        if (minutes >= open) return true
      }
    }
  }
  // Tail of an overnight window that started the previous day (00:00..close).
  const prev = days[(day + 6) % 7]
  if (prev) {
    const open = toMinutes(prev.open)
    const close = toMinutes(prev.close)
    if (open != null && close != null && close < open && minutes < close) {
      return true
    }
  }
  return false
}

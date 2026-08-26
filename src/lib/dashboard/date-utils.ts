// Centralised date helpers for the dashboard so every chart / card
// agrees on what "today", "day boundary", and "day of week" mean.
// All boundaries are computed in the user's LOCAL timezone — which is
// what a business user intuitively expects when they say "today".

export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

export function daysAgoStart(days: number): Date {
  const out = startOfLocalDay()
  out.setDate(out.getDate() - days)
  return out
}

/** Date-only key (YYYY-MM-DD) for bucketing rows by local calendar day. */
export function localDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Inclusive list of local-day keys spanning the last `n` days, in
 * chronological order. Useful for seeding chart buckets so days with
 * zero activity still render a 0-point in the line.
 */
export function lastNDayKeys(n: number): string[] {
  const keys: string[] = []
  const start = daysAgoStart(n - 1)
  for (let i = 0; i < n; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    keys.push(localDayKey(d))
  }
  return keys
}

/**
 * ISO day-of-week where 0 = Monday … 6 = Sunday. JavaScript's native
 * getDay() uses 0 = Sunday which is awkward for most business charts.
 */
export function mondayIndex(d: Date): number {
  const jsDow = d.getDay() // 0..6 with Sunday=0
  return (jsDow + 6) % 7
}

export const DOW_SHORT_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/**
 * Início do dia N dias atrás NO FUSO INFORMADO (não no UTC do container).
 * Bug do Rafael 25/08: "hoje" virava às 20h/21h locais (meia-noite UTC) e o
 * card "Mensagens enviadas hoje" zerava no meio da noite de trabalho.
 */
export function startOfDayInTz(tz: string, daysAgo: number): Date {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) // en-CA → "YYYY-MM-DD"
  const base = new Date(`${parts}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() - daysAgo)
  const local = new Date(base.toLocaleString('en-US', { timeZone: tz }))
  const utc = new Date(base.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(base.getTime() + (utc.getTime() - local.getTime()))
}

// ============================================================
// IA agenda de verdade — cria evento na Agenda quando a IA combina um horário.
// Server/worker-safe (recebe accountId/userId). Espelha no Google se a agenda
// for do Google (pushEventToGoogle, best-effort). Nunca lança.
// ============================================================

import { and, asc, eq } from 'drizzle-orm'
import { db, calendars, calendarEvents, deals } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pushEventToGoogle } from '@/lib/google/sync'

/** Offset (min) do fuso `tz` no instante `date`. Positivo = tz à frente do UTC. */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  const asUTC = Date.UTC(
    +m.year,
    +m.month - 1,
    +m.day,
    +m.hour,
    +m.minute,
    +m.second,
  )
  return (asUTC - date.getTime()) / 60000
}

/** "YYYY-MM-DDTHH:mm" (hora de PAREDE no fuso `tz`) → instante UTC (Date|null). */
export function zonedWallToUtc(local: string, tz: string): Date | null {
  const m = local.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (!m) return null
  const y = +m[1]
  const mo = +m[2]
  const d = +m[3]
  const h = +m[4]
  const mi = +m[5]
  const guessUTC = Date.UTC(y, mo - 1, d, h, mi)
  const off = tzOffsetMinutes(new Date(guessUTC), tz)
  const inst = new Date(guessUTC - off * 60000)
  return Number.isNaN(inst.getTime()) ? null : inst
}

/** Primeira agenda da conta (cria "Minha agenda" se não houver). */
async function ensureAiCalendar(
  accountId: string,
  userId: string | null,
): Promise<string> {
  const existing = firstOrNull(
    await db
      .select({ id: calendars.id })
      .from(calendars)
      .where(eq(calendars.accountId, accountId))
      .orderBy(asc(calendars.createdAt))
      .limit(1),
  )
  if (existing) return existing.id
  const [created] = await db
    .insert(calendars)
    .values({
      accountId,
      ownerUserId: userId,
      createdBy: userId,
      name: 'Minha agenda',
      color: '#6366f1',
    })
    .returning({ id: calendars.id })
  return created.id
}

export interface ScheduleResult {
  eventId: string
  startsAt: string
  title: string
}

/**
 * Cria o evento na Agenda a partir do que a IA decidiu. `startsLocal` é a hora
 * de PAREDE no fuso da conta (ex.: "2026-08-16T15:00"). Best-effort.
 */
export async function scheduleEventFromAi(input: {
  accountId: string
  userId: string | null
  conversationId: string
  contactId: string | null
  startsLocal: string
  title: string
  timezone: string
  durationMin?: number
}): Promise<ScheduleResult | null> {
  const { accountId, userId, conversationId, contactId, startsLocal, timezone } =
    input
  try {
    const start = zonedWallToUtc(startsLocal, timezone)
    if (!start) return null
    const dur = input.durationMin && input.durationMin > 0 ? input.durationMin : 60
    const end = new Date(start.getTime() + dur * 60000)
    const calendarId = await ensureAiCalendar(accountId, userId)
    const title = (input.title || 'Reunião').trim().slice(0, 200)

    // Vincula ao negócio ligado à conversa (se houver).
    const deal = firstOrNull(
      await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.conversationId, conversationId),
          ),
        )
        .limit(1),
    )

    const [created] = await db
      .insert(calendarEvents)
      .values({
        accountId,
        calendarId,
        ownerUserId: userId,
        createdBy: userId,
        title,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        contactId: contactId || null,
        dealId: deal?.id ?? null,
        source: 'local',
      })
      .returning({ id: calendarEvents.id })

    // Espelha no Google (best-effort, só se a agenda for do Google).
    try {
      await pushEventToGoogle(accountId, created.id, 'create')
    } catch (err) {
      console.error('[ai schedule] google push falhou:', err)
    }

    return { eventId: created.id, startsAt: start.toISOString(), title }
  } catch (err) {
    console.error('[ai schedule] criar evento falhou:', err)
    return null
  }
}

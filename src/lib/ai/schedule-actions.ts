// ============================================================
// IA agenda de verdade — cria evento na Agenda quando a IA combina um horário.
// Server/worker-safe (recebe accountId/userId). Espelha no Google se a agenda
// for do Google (pushEventToGoogle, best-effort). Nunca lança.
// ============================================================

import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { db, calendars, calendarEvents, deals, scheduledMessages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pushEventToGoogle } from '@/lib/google/sync'
import { enqueueScheduledMessage } from '@/lib/queue/queues'

/** DD/MM às HH:mm no fuso da conta. */
function fmtLocal(date: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  try {
    return new Intl.DateTimeFormat('pt-BR', { ...opts, timeZone: tz })
      .format(date)
      .replace(', ', ' às ')
  } catch {
    return new Intl.DateTimeFormat('pt-BR', opts).format(date)
  }
}

/**
 * Programa uma mensagem (lembrete) via scheduled_messages + enfileira o job.
 * Best-effort. Ignora se o horário já passou / está muito perto (<1min).
 * ⚠️ Fora da janela de 24h no canal OFICIAL da Meta, a entrega exige template
 * (não tratado aqui) — em canais WAHA e dentro da janela, entrega normal.
 */
async function scheduleReminderMessage(input: {
  accountId: string
  userId: string | null
  conversationId: string
  contactId: string | null
  whenUtc: Date
  text: string
}): Promise<void> {
  const delayMs = input.whenUtc.getTime() - Date.now()
  if (delayMs < 60_000) return
  try {
    const [row] = await db
      .insert(scheduledMessages)
      .values({
        accountId: input.accountId,
        conversationId: input.conversationId,
        contactId: input.contactId || null,
        messageType: 'text',
        contentText: input.text,
        scheduledAt: input.whenUtc.toISOString(),
        status: 'pending',
        createdBy: input.userId,
        assignedTo: input.userId,
        assignedBy: input.userId,
      })
      .returning({ id: scheduledMessages.id })
    try {
      await enqueueScheduledMessage(row.id, { delayMs })
    } catch (err) {
      console.error('[ai schedule] enfileirar lembrete falhou:', err)
      await db.delete(scheduledMessages).where(eq(scheduledMessages.id, row.id))
    }
  } catch (err) {
    console.error('[ai schedule] agendar lembrete falhou:', err)
  }
}

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

    // Dedup: a IA às vezes emite [[AGENDAR]] em turnos seguidos. Se já existe um
    // evento confirmado FUTURO pro mesmo negócio (ou contato), ATUALIZA o horário
    // em vez de criar outro — 1 reunião = 1 evento (evita lembrete em dobro).
    const dupMatch = deal?.id
      ? eq(calendarEvents.dealId, deal.id)
      : contactId
        ? eq(calendarEvents.contactId, contactId)
        : null
    if (dupMatch) {
      const existing = firstOrNull(
        await db
          .select({ id: calendarEvents.id })
          .from(calendarEvents)
          .where(
            and(
              eq(calendarEvents.accountId, accountId),
              eq(calendarEvents.status, 'confirmed'),
              gt(calendarEvents.startsAt, sql`now()`),
              dupMatch,
            ),
          )
          .orderBy(asc(calendarEvents.startsAt))
          .limit(1),
      )
      if (existing) {
        await db
          .update(calendarEvents)
          .set({ startsAt: start.toISOString(), endsAt: end.toISOString(), title })
          .where(eq(calendarEvents.id, existing.id))
        try {
          await pushEventToGoogle(accountId, existing.id, 'update')
        } catch (err) {
          console.error('[ai schedule] google update falhou:', err)
        }
        return { eventId: existing.id, startsAt: start.toISOString(), title }
      }
    }

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

    // Lembretes de reunião: agora são feitos pelo sweep configurável
    // (runMeetingReminderSweep, ancorado no horário do evento + canal-aware +
    // 1x via reminders_sent). O antigo pré/pós hardcoded foi removido — ele
    // duplicava (1 por evento, sem dedup) e causava spam quando havia eventos
    // repetidos.

    return { eventId: created.id, startsAt: start.toISOString(), title }
  } catch (err) {
    console.error('[ai schedule] criar evento falhou:', err)
    return null
  }
}

'use server'

// ============================================================
// Agenda — server actions (base interna; sync Google entra depois).
// Multi-calendário por conta; eventos com vínculo opcional a contato/negócio.
// v1: escopo por conta (time vê a agenda da conta); owner_user_id marca o dono.
// ============================================================

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import { db, calendars, calendarEvents, calendarConnections, contacts, deals, user } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { googleConfigured } from '@/lib/google/calendar'
import { importGoogleEvents } from '@/lib/google/sync'

export type CalendarRow = {
  id: string
  name: string
  color: string
  ownerUserId: string | null
  ownerName: string | null
  source: 'local' | 'google'
  isVisible: boolean
}

export type EventRow = {
  id: string
  calendarId: string
  calendarName: string
  calendarColor: string
  title: string
  description: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  status: 'confirmed' | 'cancelled'
  source: 'local' | 'google'
  ownerUserId: string | null
  ownerName: string | null
  contactId: string | null
  contactName: string | null
  dealId: string | null
  dealTitle: string | null
}

export type EventInput = {
  title: string
  startsAt: string
  endsAt: string
  allDay?: boolean
  calendarId?: string | null
  description?: string | null
  location?: string | null
  contactId?: string | null
  dealId?: string | null
}

/** Garante (e devolve) uma agenda padrão do usuário; cria "Minha agenda" se faltar. */
async function ensureDefaultCalendar(
  accountId: string,
  userId: string,
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
  const created = firstOrThrow(
    await db
      .insert(calendars)
      .values({
        accountId,
        ownerUserId: userId,
        createdBy: userId,
        name: 'Minha agenda',
        color: '#6366f1',
      })
      .returning({ id: calendars.id }),
  )
  return created.id
}

/** Agendas da conta (cria a padrão na primeira visita). */
export async function listCalendars(): Promise<CalendarRow[]> {
  const ctx = await getCurrentAccount()
  await ensureDefaultCalendar(ctx.accountId, ctx.userId)
  const rows = await db
    .select({
      id: calendars.id,
      name: calendars.name,
      color: calendars.color,
      ownerUserId: calendars.ownerUserId,
      ownerName: user.name,
      source: calendars.source,
      isVisible: calendars.isVisible,
    })
    .from(calendars)
    .leftJoin(user, eq(calendars.ownerUserId, user.id))
    .where(eq(calendars.accountId, ctx.accountId))
    .orderBy(asc(calendars.createdAt))
  return rows as CalendarRow[]
}

/** Eventos num intervalo [from, to] (ISO). Junta cor/dono/contato/negócio. */
export async function listEvents(range: {
  from: string
  to: string
}): Promise<EventRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: calendarEvents.id,
      calendarId: calendarEvents.calendarId,
      calendarName: calendars.name,
      calendarColor: calendars.color,
      title: calendarEvents.title,
      description: calendarEvents.description,
      location: calendarEvents.location,
      startsAt: calendarEvents.startsAt,
      endsAt: calendarEvents.endsAt,
      allDay: calendarEvents.allDay,
      status: calendarEvents.status,
      source: calendarEvents.source,
      ownerUserId: calendarEvents.ownerUserId,
      ownerName: user.name,
      contactId: calendarEvents.contactId,
      contactName: contacts.name,
      dealId: calendarEvents.dealId,
      dealTitle: deals.title,
    })
    .from(calendarEvents)
    .innerJoin(calendars, eq(calendarEvents.calendarId, calendars.id))
    .leftJoin(user, eq(calendarEvents.ownerUserId, user.id))
    .leftJoin(contacts, eq(calendarEvents.contactId, contacts.id))
    .leftJoin(deals, eq(calendarEvents.dealId, deals.id))
    .where(
      and(
        eq(calendarEvents.accountId, ctx.accountId),
        // Sobreposição com a janela: começa antes do fim E termina depois do início.
        lte(calendarEvents.startsAt, range.to),
        gte(calendarEvents.endsAt, range.from),
      ),
    )
    .orderBy(asc(calendarEvents.startsAt))
  return rows as EventRow[]
}

export async function createEvent(
  input: EventInput,
): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const title = input.title?.trim()
    if (!title) return { id: null, error: 'Título é obrigatório' }
    if (!input.startsAt || !input.endsAt)
      return { id: null, error: 'Início e fim são obrigatórios' }

    const calendarId =
      input.calendarId ?? (await ensureDefaultCalendar(ctx.accountId, ctx.userId))

    const created = firstOrThrow(
      await db
        .insert(calendarEvents)
        .values({
          accountId: ctx.accountId,
          calendarId,
          ownerUserId: ctx.userId,
          createdBy: ctx.userId,
          title,
          description: input.description?.trim() || null,
          location: input.location?.trim() || null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          allDay: input.allDay ?? false,
          contactId: input.contactId || null,
          dealId: input.dealId || null,
        })
        .returning({ id: calendarEvents.id }),
    )
    return { id: created.id, error: null }
  } catch (err) {
    return { id: null, error: err instanceof Error ? err.message : 'Falha ao criar evento' }
  }
}

export async function updateEvent(
  id: string,
  patch: Partial<EventInput> & { status?: 'confirmed' | 'cancelled' },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const set: Record<string, unknown> = { updatedAt: sql`now()` }
    if (patch.title !== undefined) set.title = patch.title.trim()
    if (patch.description !== undefined) set.description = patch.description?.trim() || null
    if (patch.location !== undefined) set.location = patch.location?.trim() || null
    if (patch.startsAt !== undefined) set.startsAt = patch.startsAt
    if (patch.endsAt !== undefined) set.endsAt = patch.endsAt
    if (patch.allDay !== undefined) set.allDay = patch.allDay
    if (patch.calendarId !== undefined) set.calendarId = patch.calendarId
    if (patch.contactId !== undefined) set.contactId = patch.contactId || null
    if (patch.dealId !== undefined) set.dealId = patch.dealId || null
    if (patch.status !== undefined) set.status = patch.status

    await db
      .update(calendarEvents)
      .set(set)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao atualizar evento' }
  }
}

export async function deleteEvent(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(calendarEvents)
      .where(and(eq(calendarEvents.id, id), eq(calendarEvents.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover evento' }
  }
}

export async function createCalendar(input: {
  name: string
  color?: string
}): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const name = input.name?.trim()
    if (!name) return { id: null, error: 'Nome é obrigatório' }
    const created = firstOrThrow(
      await db
        .insert(calendars)
        .values({
          accountId: ctx.accountId,
          ownerUserId: ctx.userId,
          createdBy: ctx.userId,
          name,
          color: input.color?.trim() || '#6366f1',
        })
        .returning({ id: calendars.id }),
    )
    return { id: created.id, error: null }
  } catch (err) {
    return { id: null, error: err instanceof Error ? err.message : 'Falha ao criar agenda' }
  }
}

export async function updateCalendar(
  id: string,
  patch: { name?: string; color?: string; isVisible?: boolean },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const set: Record<string, unknown> = { updatedAt: sql`now()` }
    if (patch.name !== undefined) set.name = patch.name.trim()
    if (patch.color !== undefined) set.color = patch.color.trim()
    if (patch.isVisible !== undefined) set.isVisible = patch.isVisible
    await db
      .update(calendars)
      .set(set)
      .where(and(eq(calendars.id, id), eq(calendars.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao atualizar agenda' }
  }
}

export async function deleteCalendar(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Não deixa apagar a última agenda da conta.
    const count = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(calendars)
      .where(eq(calendars.accountId, ctx.accountId))
    if ((count[0]?.n ?? 0) <= 1) {
      return { error: 'Você precisa de pelo menos uma agenda.' }
    }
    await db
      .delete(calendars)
      .where(and(eq(calendars.id, id), eq(calendars.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover agenda' }
  }
}

// ---------- Google Calendar ----------

export type GoogleStatus = {
  configured: boolean // env do servidor pronto (GOOGLE_CLIENT_ID/SECRET)
  connected: boolean
  email: string | null
}

/** Estado da conexão Google do usuário atual. */
export async function getGoogleStatus(): Promise<GoogleStatus> {
  const ctx = await getCurrentAccount()
  const conn = firstOrNull(
    await db
      .select({ email: calendarConnections.googleEmail })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
      .limit(1),
  )
  return { configured: googleConfigured(), connected: Boolean(conn), email: conn?.email ?? null }
}

/** Reimporta eventos das agendas Google do usuário (Google → CRM). */
export async function syncGoogleNow(): Promise<{ imported: number; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const conns = await db
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
    let imported = 0
    for (const c of conns) {
      const r = await importGoogleEvents(ctx.accountId, c.id)
      imported += r.imported
    }
    return { imported, error: null }
  } catch (err) {
    return { imported: 0, error: err instanceof Error ? err.message : 'Falha ao sincronizar' }
  }
}

/** Desconecta o Google (apaga a conexão; as agendas Google saem em cascata). */
export async function disconnectGoogle(): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, ctx.accountId),
          eq(calendarConnections.userId, ctx.userId),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao desconectar' }
  }
}

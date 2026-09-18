// ============================================================
// Google Calendar — sync (import Google → CRM) + refresh de token.
// v1: importa eventos das agendas do Google conectadas. O outbound
// (CRM → Google) entra na etapa seguinte.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { zonedIso } from '@/lib/assistant/rules'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  refreshAccessToken,
  listGoogleEvents,
  insertGoogleEvent,
  patchGoogleEvent,
  deleteGoogleEvent,
  type GoogleEvent,
  type GoogleEventBody,
} from './calendar'

type ConnectionRow = {
  id: string
  accessToken: string
  refreshToken: string | null
  tokenExpiry: string | null
}

/** Access token válido; renova pelo refresh_token quando perto de expirar. */
export async function getValidAccessToken(conn: ConnectionRow): Promise<string> {
  const expiryMs = conn.tokenExpiry ? Date.parse(conn.tokenExpiry) : 0
  const stillValid = expiryMs - Date.now() > 60_000
  if (stillValid) return decrypt(conn.accessToken)

  if (!conn.refreshToken) return decrypt(conn.accessToken) // sem refresh: tenta o atual
  const refreshed = await refreshAccessToken(decrypt(conn.refreshToken))
  const newExpiry = new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000).toISOString()
  await db
    .update(calendarConnections)
    .set({ accessToken: encrypt(refreshed.access_token), tokenExpiry: newExpiry, updatedAt: sql`now()` })
    .where(eq(calendarConnections.id, conn.id))
  return refreshed.access_token
}

/** 'YYYY-MM-DD' − 1 dia (o fim de evento de dia inteiro no Google é EXCLUSIVO). */
function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Datas do Google → instantes nossos.
 *
 * O evento de DIA INTEIRO é uma data solta ("2026-09-15"), não um instante. A v1
 * fazia `new Date('2026-09-15T00:00:00')`, que o Node lê no fuso do servidor
 * (UTC no container) — em Brasília isso vira 14/09 21:00, e o compromisso
 * aparecia um dia antes (o "Equipotel" do Renato, 17/09). Agora a data é
 * ancorada no fuso da conta, na mesma convenção que a Agenda já usa pros
 * eventos criados aqui: 00:00 do primeiro dia → 23:59 do último dia coberto.
 */
function mapTimes(ev: GoogleEvent, tz: string): { startsAt: string; endsAt: string; allDay: boolean } | null {
  if (ev.start?.date && ev.end?.date) {
    const lastDay = previousDay(ev.end.date)
    const endDay = lastDay < ev.start.date ? ev.start.date : lastDay
    return {
      startsAt: zonedIso(ev.start.date, '00:00', tz),
      endsAt: zonedIso(endDay, '23:59', tz),
      allDay: true,
    }
  }
  const s = ev.start?.dateTime ?? null
  const e = ev.end?.dateTime ?? null
  if (!s || !e) return null
  return { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), allDay: false }
}

/** 'YYYY-MM-DD' de um instante, no fuso da conta (pro Google, que quer data). */
function dateInTz(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/** Importa eventos (janela -7d…+60d) de todas as agendas Google desta conexão. */
export async function importGoogleEvents(
  accountId: string,
  connectionId: string,
): Promise<{ imported: number; cancelled: number }> {
  const conn = firstOrNull(
    await db
      .select({
        id: calendarConnections.id,
        accessToken: calendarConnections.accessToken,
        refreshToken: calendarConnections.refreshToken,
        tokenExpiry: calendarConnections.tokenExpiry,
      })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.id, connectionId), eq(calendarConnections.accountId, accountId)))
      .limit(1),
  )
  if (!conn) return { imported: 0, cancelled: 0 }

  try {
    const accessToken = await getValidAccessToken(conn)
    // Fuso da conta: é o que ancora as datas dos eventos de dia inteiro.
    const tz = (await getAccountSettings(accountId)).businessTimezone || 'America/Sao_Paulo'

    const cals = await db
      .select({ id: calendars.id, googleCalendarId: calendars.googleCalendarId })
      .from(calendars)
      .where(and(eq(calendars.accountId, accountId), eq(calendars.connectionId, connectionId)))

    const timeMin = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const timeMax = new Date(Date.now() + 60 * 86_400_000).toISOString()

    let imported = 0
    let cancelled = 0
    for (const cal of cals) {
      if (!cal.googleCalendarId) continue
      // showDeleted: o apagado precisa CHEGAR aqui pra liberar o horário.
      const events = await listGoogleEvents(accessToken, cal.googleCalendarId, timeMin, timeMax, {
        showDeleted: true,
      })
      for (const ev of events) {
        // Apagado no Google. Vem antes de mapTimes de propósito: evento apagado
        // costuma voltar só com o id, sem start/end — se caísse no mapTimes,
        // seria descartado e a cópia daqui seguiria ocupando o horário.
        if (ev.status === 'cancelled') {
          const res = await db
            .update(calendarEvents)
            .set({ status: 'cancelled', updatedAt: sql`now()` })
            .where(
              and(
                eq(calendarEvents.calendarId, cal.id),
                eq(calendarEvents.googleEventId, ev.id),
                eq(calendarEvents.status, 'confirmed'),
              ),
            )
            .returning({ id: calendarEvents.id })
          cancelled += res.length
          continue
        }
        const times = mapTimes(ev, tz)
        if (!times) continue
        const existing = firstOrNull(
          await db
            .select({ id: calendarEvents.id })
            .from(calendarEvents)
            .where(and(eq(calendarEvents.calendarId, cal.id), eq(calendarEvents.googleEventId, ev.id)))
            .limit(1),
        )
        const values = {
          title: ev.summary?.trim() || '(sem título)',
          description: ev.description ?? null,
          location: ev.location ?? null,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          allDay: times.allDay,
          status: 'confirmed',
          // "Mostrar como: Disponível" no Google não ocupa o horário (0183).
          busy: ev.transparency !== 'transparent',
        }
        if (existing) {
          await db.update(calendarEvents).set({ ...values, updatedAt: sql`now()` }).where(eq(calendarEvents.id, existing.id))
        } else {
          await db.insert(calendarEvents).values({
            accountId,
            calendarId: cal.id,
            title: values.title,
            description: values.description,
            location: values.location,
            startsAt: values.startsAt,
            endsAt: values.endsAt,
            allDay: values.allDay,
            status: values.status,
            busy: values.busy,
            source: 'google',
            googleEventId: ev.id,
          })
          imported += 1
        }
      }
    }
    await db
      .update(calendarConnections)
      .set({ lastSyncedAt: sql`now()`, lastSyncError: null, updatedAt: sql`now()` })
      .where(eq(calendarConnections.id, connectionId))
    return { imported, cancelled }
  } catch (err) {
    // Grava o motivo em vez de sumir com ele: token revogado tem que aparecer
    // na tela como "reconecte", não virar agenda vazia (= IA oferecendo tudo).
    const msg = err instanceof Error ? err.message : String(err)
    await db
      .update(calendarConnections)
      .set({ lastSyncError: msg.slice(0, 500), updatedAt: sql`now()` })
      .where(eq(calendarConnections.id, connectionId))
      .catch(() => {})
    throw err
  }
}

// ============================================================
// Sincronização automática. Até 17/09 a importação só rodava no clique
// ("Sincronizar" na Agenda) ou no instante da conexão — com a IA marcando
// reunião sozinha, isso significa oferecer horário em cima de uma foto velha
// da agenda do dono.
// ============================================================

/** Quanto tempo uma sincronização continua "fresca" para o caminho da IA. */
export const SYNC_FRESH_MS = 90_000

type ConnRef = { id: string; accountId: string }

async function connectionsOf(accountId?: string): Promise<ConnRef[]> {
  const base = db
    .select({ id: calendarConnections.id, accountId: calendarConnections.accountId })
    .from(calendarConnections)
  return accountId ? base.where(eq(calendarConnections.accountId, accountId)) : base
}

/**
 * Sincroniza as conexões de UMA conta. Usada antes de a IA oferecer horário.
 * Nunca lança e nunca demora: respeita a carência de `maxAgeMs` (não martela o
 * Google a cada mensagem) e desiste em `timeoutMs` — agenda um pouco velha é
 * ruim, resposta travada é pior.
 */
export async function syncAccountCalendars(
  accountId: string,
  opts: { maxAgeMs?: number; timeoutMs?: number } = {},
): Promise<{ synced: number }> {
  const maxAgeMs = opts.maxAgeMs ?? SYNC_FRESH_MS
  const timeoutMs = opts.timeoutMs ?? 4_000
  try {
    const stale = await db
      .select({ id: calendarConnections.id })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.accountId, accountId),
          sql`(${calendarConnections.lastSyncedAt} IS NULL OR ${calendarConnections.lastSyncedAt} < now() - ${sql.raw(`interval '${Math.round(maxAgeMs / 1000)} seconds'`)})`,
        ),
      )
    if (!stale.length) return { synced: 0 }

    const work = Promise.all(
      stale.map((c) => importGoogleEvents(accountId, c.id).catch(() => null)),
    )
    const done = await Promise.race([
      work.then((rs) => rs.filter(Boolean).length),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), timeoutMs)),
    ])
    return { synced: done }
  } catch (err) {
    console.error('[google sync] conta', accountId, err instanceof Error ? err.message : err)
    return { synced: 0 }
  }
}

/** Varre TODAS as contas — é o que o worker periódico chama. */
export async function syncAllGoogleConnections(): Promise<{ ok: number; failed: number }> {
  let ok = 0
  let failed = 0
  const conns = await connectionsOf()
  for (const c of conns) {
    try {
      const r = await importGoogleEvents(c.accountId, c.id)
      ok += 1
      if (r.imported || r.cancelled) {
        console.log(`[google sync] ${c.accountId}: +${r.imported} novo(s), ${r.cancelled} liberado(s)`)
      }
    } catch (err) {
      // Uma conexão podre (token revogado) não pode derrubar a varredura das
      // outras contas. O motivo já foi gravado em last_sync_error.
      failed += 1
      console.error(`[google sync] ${c.accountId} falhou:`, err instanceof Error ? err.message : err)
    }
  }
  return { ok, failed }
}

// ============================================================
// CRM → Google (mão dupla). Ao criar/editar/apagar um evento numa
// agenda do Google, espelha a operação no Google Calendar.
// Best-effort: falha aqui não derruba a operação no CRM.
// ============================================================

type PushRow = {
  id: string
  title: string
  description: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  googleEventId: string | null
  calGoogleId: string | null
  connectionId: string | null
}

function toGoogleBody(row: PushRow, tz: string): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: {},
    end: {},
  }
  if (row.allDay) {
    // Google usa datas (YYYY-MM-DD) e o fim é EXCLUSIVO. As datas saem do fuso
    // da conta, não de `slice(0,10)` do ISO: fatiar o UTC só acerta por acidente
    // em fuso negativo e erra o dia em qualquer fuso a leste de Greenwich.
    const startDate = dateInTz(row.startsAt, tz)
    const lastDay = dateInTz(row.endsAt, tz)
    const exclusive = new Date(`${(lastDay < startDate ? startDate : lastDay)}T00:00:00Z`)
    exclusive.setUTCDate(exclusive.getUTCDate() + 1)
    body.start.date = startDate
    body.end.date = exclusive.toISOString().slice(0, 10)
  } else {
    // O Postgres devolve timestamptz como "2026-08-13 15:00:00+00" (com espaço,
    // sem T/Z) — o Google exige RFC3339. new Date().toISOString() normaliza.
    body.start.dateTime = new Date(row.startsAt).toISOString()
    body.end.dateTime = new Date(row.endsAt).toISOString()
  }
  return body
}

/** Espelha um evento do CRM no Google. op: 'create' | 'update' | 'delete'.
 *  No-op se a agenda do evento não for do Google. */
export async function pushEventToGoogle(
  accountId: string,
  eventId: string,
  op: 'create' | 'update' | 'delete',
  /**
   * Só na criação: sala do Google Meet + convidados (o Google manda o convite
   * por e-mail). Renato/Zelo 18/09: "teria que ir pro calendário, marcar a
   * reunião, convidar ela e eu e agendar o Google Meet".
   */
  opts: { meet?: boolean; attendees?: string[] } = {},
): Promise<{ hangoutLink?: string } | void> {
  const row = firstOrNull(
    await db
      .select({
        id: calendarEvents.id,
        title: calendarEvents.title,
        description: calendarEvents.description,
        location: calendarEvents.location,
        startsAt: calendarEvents.startsAt,
        endsAt: calendarEvents.endsAt,
        allDay: calendarEvents.allDay,
        googleEventId: calendarEvents.googleEventId,
        calGoogleId: calendars.googleCalendarId,
        connectionId: calendars.connectionId,
      })
      .from(calendarEvents)
      .innerJoin(calendars, eq(calendarEvents.calendarId, calendars.id))
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.accountId, accountId)))
      .limit(1),
  )
  // Agenda local (não-Google) → nada a espelhar.
  if (!row || !row.calGoogleId || !row.connectionId) return

  const conn = firstOrNull(
    await db
      .select({
        id: calendarConnections.id,
        accessToken: calendarConnections.accessToken,
        refreshToken: calendarConnections.refreshToken,
        tokenExpiry: calendarConnections.tokenExpiry,
      })
      .from(calendarConnections)
      .where(eq(calendarConnections.id, row.connectionId))
      .limit(1),
  )
  if (!conn) return

  const accessToken = await getValidAccessToken(conn)

  if (op === 'delete') {
    if (row.googleEventId) await deleteGoogleEvent(accessToken, row.calGoogleId, row.googleEventId)
    return
  }

  const tz = (await getAccountSettings(accountId)).businessTimezone || 'America/Sao_Paulo'
  const body = toGoogleBody(row as PushRow, tz)

  if (op === 'update' && row.googleEventId) {
    try {
      await patchGoogleEvent(accessToken, row.calGoogleId, row.googleEventId, body)
    } catch (err) {
      // Evento não existe mais no Google (404) → recria e regrava o id.
      if (String(err).includes('(404)')) {
        const recreated = await insertGoogleEvent(accessToken, row.calGoogleId, body)
        await db
          .update(calendarEvents)
          .set({ googleEventId: recreated.id, updatedAt: sql`now()` })
          .where(eq(calendarEvents.id, eventId))
      } else {
        throw err
      }
    }
    return
  }

  // create (ou update de um evento que ainda não existe no Google)
  if (op === 'create') {
    const emails = [...new Set((opts.attendees ?? []).map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))]
    if (emails.length) body.attendees = emails.map((email) => ({ email }))
    if (opts.meet) {
      body.conferenceData = {
        createRequest: { requestId: `fluxia-${eventId}`, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      }
    }
  }
  const created = await insertGoogleEvent(accessToken, row.calGoogleId, body)
  await db
    .update(calendarEvents)
    .set({
      googleEventId: created.id,
      source: 'google',
      // O link da sala vira o "local" da reunião (quem abre na Agenda do CRM
      // já vê onde entrar) — sem apagar um local que já existia.
      ...(created.hangoutLink && !row.location ? { location: created.hangoutLink } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(calendarEvents.id, eventId))
  return { hangoutLink: created.hangoutLink }
}

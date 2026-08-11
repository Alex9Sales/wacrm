// ============================================================
// Google Calendar — sync (import Google → CRM) + refresh de token.
// v1: importa eventos das agendas do Google conectadas. O outbound
// (CRM → Google) entra na etapa seguinte.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars, calendarEvents } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
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

function mapTimes(ev: GoogleEvent): { startsAt: string; endsAt: string; allDay: boolean } | null {
  const s = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00` : null)
  const e = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00` : null)
  if (!s || !e) return null
  return { startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString(), allDay: Boolean(ev.start?.date) }
}

/** Importa eventos (janela -7d…+60d) de todas as agendas Google desta conexão. */
export async function importGoogleEvents(
  accountId: string,
  connectionId: string,
): Promise<{ imported: number }> {
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
  if (!conn) return { imported: 0 }

  const accessToken = await getValidAccessToken(conn)

  const cals = await db
    .select({ id: calendars.id, googleCalendarId: calendars.googleCalendarId })
    .from(calendars)
    .where(and(eq(calendars.accountId, accountId), eq(calendars.connectionId, connectionId)))

  const timeMin = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const timeMax = new Date(Date.now() + 60 * 86_400_000).toISOString()

  let imported = 0
  for (const cal of cals) {
    if (!cal.googleCalendarId) continue
    const events = await listGoogleEvents(accessToken, cal.googleCalendarId, timeMin, timeMax)
    for (const ev of events) {
      const times = mapTimes(ev)
      if (!times) continue
      const status = ev.status === 'cancelled' ? 'cancelled' : 'confirmed'
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
        status,
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
          source: 'google',
          googleEventId: ev.id,
        })
        imported += 1
      }
    }
  }
  return { imported }
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

function toGoogleBody(row: PushRow): GoogleEventBody {
  const body: GoogleEventBody = {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: {},
    end: {},
  }
  if (row.allDay) {
    // Google usa datas (YYYY-MM-DD); fim é exclusivo.
    body.start.date = row.startsAt.slice(0, 10)
    let endDate = row.endsAt.slice(0, 10)
    if (endDate <= row.startsAt.slice(0, 10)) {
      const d = new Date(`${row.startsAt.slice(0, 10)}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() + 1)
      endDate = d.toISOString().slice(0, 10)
    }
    body.end.date = endDate
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
): Promise<void> {
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

  const body = toGoogleBody(row as PushRow)

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
  const created = await insertGoogleEvent(accessToken, row.calGoogleId, body)
  await db
    .update(calendarEvents)
    .set({ googleEventId: created.id, source: 'google', updatedAt: sql`now()` })
    .where(eq(calendarEvents.id, eventId))
}

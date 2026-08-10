// GET /api/google/calendar/callback — retorno do OAuth do Google.
// Troca o code por tokens, guarda a conexão (tokens criptografados),
// importa as agendas do Google como calendars locais e puxa os eventos.

import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'
import { db, calendarConnections, calendars } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { verifyState, exchangeCode, fetchUserEmail, listCalendarList } from '@/lib/google/calendar'
import { importGoogleEvents } from '@/lib/google/sync'

export async function GET(request: Request) {
  const base = (process.env.BETTER_AUTH_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const back = (q: string) => NextResponse.redirect(`${base}/agenda?${q}`)
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const oauthError = url.searchParams.get('error')
    if (oauthError) return back(`google=error&reason=${encodeURIComponent(oauthError)}`)
    if (!code || !verifyState(state)) return back('google=error&reason=state')

    const tokens = await exchangeCode(code)
    const email = await fetchUserEmail(tokens.access_token)
    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString()

    // Upsert da conexão por (user, email).
    const existing = firstOrNull(
      await db
        .select({ id: calendarConnections.id })
        .from(calendarConnections)
        .where(
          and(
            eq(calendarConnections.userId, ctx.userId),
            eq(calendarConnections.googleEmail, email ?? ''),
          ),
        )
        .limit(1),
    )
    let connectionId: string
    if (existing) {
      connectionId = existing.id
      await db
        .update(calendarConnections)
        .set({
          accessToken: encrypt(tokens.access_token),
          // refresh_token só volta no 1º consent; preserva o antigo se não vier.
          ...(tokens.refresh_token ? { refreshToken: encrypt(tokens.refresh_token) } : {}),
          tokenExpiry: expiry,
          scope: tokens.scope ?? null,
          updatedAt: sql`now()`,
        })
        .where(eq(calendarConnections.id, connectionId))
    } else {
      const created = firstOrThrow(
        await db
          .insert(calendarConnections)
          .values({
            accountId: ctx.accountId,
            userId: ctx.userId,
            googleEmail: email,
            accessToken: encrypt(tokens.access_token),
            refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
            tokenExpiry: expiry,
            scope: tokens.scope ?? null,
          })
          .returning({ id: calendarConnections.id }),
      )
      connectionId = created.id
    }

    // Agendas do Google → calendars locais (source google).
    const list = await listCalendarList(tokens.access_token)
    for (const gcal of list) {
      const already = firstOrNull(
        await db
          .select({ id: calendars.id })
          .from(calendars)
          .where(and(eq(calendars.accountId, ctx.accountId), eq(calendars.googleCalendarId, gcal.id)))
          .limit(1),
      )
      if (already) {
        await db
          .update(calendars)
          .set({ connectionId, source: 'google', updatedAt: sql`now()` })
          .where(eq(calendars.id, already.id))
      } else {
        await db.insert(calendars).values({
          accountId: ctx.accountId,
          ownerUserId: ctx.userId,
          createdBy: ctx.userId,
          name: gcal.summary || 'Google',
          color: gcal.backgroundColor || '#4285F4',
          source: 'google',
          googleCalendarId: gcal.id,
          connectionId,
        })
      }
    }

    await importGoogleEvents(ctx.accountId, connectionId)
    return back(`google=connected&email=${encodeURIComponent(email ?? '')}`)
  } catch (err) {
    console.error('[google/calendar/callback]', err)
    const msg = err instanceof Error ? err.message.slice(0, 140) : 'falha'
    return back(`google=error&reason=${encodeURIComponent(msg)}`)
  }
}

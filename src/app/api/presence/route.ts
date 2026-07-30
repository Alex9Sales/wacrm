// ============================================================
// Presence (Fase 3).
//   POST /api/presence  { status: 'online' | 'away' }  — heartbeat: upsert the
//     caller's presence row (status + last_seen_at = now).
//   GET  /api/presence  — all presence rows for the caller's account, so the
//     UI can show who's online/away/offline (offline is derived client-side
//     from last_seen_at staleness — see src/lib/presence.ts).
//
// Client code can't touch Drizzle, so the heartbeat component + usePresence
// hook talk to this. Account-scoped; no RLS.
// ============================================================

import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'

import { db, memberPresence } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        user_id: memberPresence.userId,
        status: memberPresence.status,
        last_seen_at: memberPresence.lastSeenAt,
      })
      .from(memberPresence)
      .where(eq(memberPresence.accountId, ctx.accountId))
    return NextResponse.json({ presence: rows })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as { status?: unknown }
    // Manual presence (Fase 3.1): the member picks online / away / offline.
    const status =
      body.status === 'away' || body.status === 'offline'
        ? body.status
        : 'online'
    const now = new Date().toISOString()
    await db
      .insert(memberPresence)
      .values({
        accountId: ctx.accountId,
        userId: ctx.userId,
        status,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: memberPresence.userId,
        set: { status, lastSeenAt: now, accountId: ctx.accountId },
      })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

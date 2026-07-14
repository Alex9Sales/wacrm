// ============================================================
// POST /api/calls/waha/{callId} — control an active/incoming waha-voip call.
// Body: { action: 'accept' | 'end' | 'reject', from? }.
//
//   accept  → answer an incoming call (browser then negotiates via /webrtc)
//   end     → hang up an active call
//   reject  → decline an incoming call (needs `from`, the caller chatId)
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, callLogs } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  wahaCallsForAccount,
  wahaCallsForChannel,
  wahaCallsPost,
} from '@/lib/channels/waha-calls'

interface RouteParams {
  params: Promise<{ callId: string }>
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { callId } = await params
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      action?: 'accept' | 'end' | 'reject'
      from?: string
      channelId?: string
    }
    const action = body.action
    if (action !== 'accept' && action !== 'end' && action !== 'reject') {
      return NextResponse.json(
        { error: 'action must be accept | end | reject' },
        { status: 400 },
      )
    }
    if (action === 'reject' && !body.from) {
      return NextResponse.json(
        { error: 'from required to reject' },
        { status: 400 },
      )
    }

    const coords =
      (body.channelId
        ? await wahaCallsForChannel(ctx.accountId, body.channelId)
        : null) ?? (await wahaCallsForAccount(ctx.accountId))
    if (!coords) {
      return NextResponse.json(
        { error: 'No WAHA calls engine configured' },
        { status: 400 },
      )
    }

    const payload: Record<string, unknown> =
      action === 'reject'
        ? { from: body.from, id: callId }
        : { id: callId }
    const r = await wahaCallsPost(coords, action, payload)
    if (!r.ok) {
      console.error(
        `[waha-calls] ${action} failed`,
        r.status,
        JSON.stringify(r.data),
      )
      return NextResponse.json(
        { error: `${action} failed`, data: r.data },
        { status: 502 },
      )
    }

    // Mark the history row answered on accept — authoritative. gows does NOT
    // emit call.accepted for our OWN accept (only for accept-elsewhere), so
    // without this the call ends as 'rejected' from the terminate event.
    if (action === 'accept') {
      try {
        await db
          .update(callLogs)
          .set({ status: 'answered', updatedAt: new Date().toISOString() })
          .where(
            and(
              eq(callLogs.accountId, ctx.accountId),
              eq(callLogs.externalCallId, callId),
            ),
          )
      } catch (err) {
        console.error('[waha-calls] mark answered failed:', err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

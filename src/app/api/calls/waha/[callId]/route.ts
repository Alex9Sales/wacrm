// ============================================================
// POST /api/calls/waha/{callId} — control an active/incoming waha-voip call.
// Body: { action: 'accept' | 'claim' | 'end' | 'reject', from? }.
//
//   accept  → answer an incoming call (browser then negotiates via /webrtc)
//   claim   → take over a call that's ALREADY answered by the AI (Fatia 5B
//             handoff): grab the atomic lock WITHOUT re-accepting at the engine
//             (gows already accepted it for the AI), then the browser attaches
//             its own media leg via /webrtc. Re-accepting an active call is
//             undefined on gows, so a takeover must not do it.
//   end     → hang up an active call
//   reject  → decline an incoming call (needs `from`, the caller chatId)
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq, isNull } from 'drizzle-orm'

import { db, callLogs } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { publishEvent } from '@/lib/events/publish'
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
      action?: 'accept' | 'claim' | 'end' | 'reject'
      from?: string
      channelId?: string
    }
    const action = body.action
    if (
      action !== 'accept' &&
      action !== 'claim' &&
      action !== 'end' &&
      action !== 'reject'
    ) {
      return NextResponse.json(
        { error: 'action must be accept | claim | end | reject' },
        { status: 400 },
      )
    }
    if (action === 'reject' && !body.from) {
      return NextResponse.json(
        { error: 'from required to reject' },
        { status: 400 },
      )
    }

    // An inbound call rings on EVERY agent's browser (the SSE fans out to the
    // whole account), so the first accept has to win. Claim atomically —
    // UPDATE ... WHERE claimed_by IS NULL — BEFORE touching the engine, so a
    // loser never answers a call someone else already took.
    if (action === 'accept' || action === 'claim') {
      const won = await db
        .update(callLogs)
        .set({
          claimedBy: ctx.userId,
          status: 'answered',
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(callLogs.accountId, ctx.accountId),
            eq(callLogs.externalCallId, callId),
            isNull(callLogs.claimedBy),
          ),
        )
        .returning({ id: callLogs.id })
      if (won.length === 0) {
        // Lost the race, or there's simply no history row yet (the webhook
        // insert can lag an outbound/edge case) — only block on a real loss.
        const [existing] = await db
          .select({ claimedBy: callLogs.claimedBy })
          .from(callLogs)
          .where(
            and(
              eq(callLogs.accountId, ctx.accountId),
              eq(callLogs.externalCallId, callId),
            ),
          )
          .limit(1)
        if (existing?.claimedBy && existing.claimedBy !== ctx.userId) {
          return NextResponse.json(
            { error: 'already_claimed' },
            { status: 409 },
          )
        }
      }
    }

    // 'claim' is DB-only (the AI already accepted the call at the engine); a
    // takeover must not re-accept. Skip the engine round-trip entirely.
    if (action !== 'claim') {
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
    }

    // Mark the history row answered on accept/claim — authoritative. gows does
    // NOT emit call.accepted for our OWN accept (only for accept-elsewhere), so
    // without this the call ends as 'rejected' from the terminate event.
    // (The claim above already set it; this covers the no-row-yet case.)
    if (action === 'accept' || action === 'claim') {
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
        // Tell the other agents' ringing modals to stand down.
        await publishEvent(ctx.accountId, {
          type: 'call_claimed',
          callId,
          by: ctx.userId,
        })
      } catch (err) {
        console.error('[waha-calls] mark answered failed:', err)
      }
    }

    // The leg is over — free the channel so the next inbound isn't treated as
    // "busy" (WhatsApp allows one active call per number).
    if (action === 'end' || action === 'reject') {
      try {
        const now = new Date().toISOString()
        await db
          .update(callLogs)
          .set({ endedAt: now, updatedAt: now })
          .where(
            and(
              eq(callLogs.accountId, ctx.accountId),
              eq(callLogs.externalCallId, callId),
              isNull(callLogs.endedAt),
            ),
          )
      } catch (err) {
        console.error('[waha-calls] mark ended failed:', err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

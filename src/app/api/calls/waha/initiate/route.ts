// ============================================================
// POST /api/calls/waha/initiate — start an OUTBOUND unofficial WhatsApp voice
// call (business → customer) through the waha-voip engine. Body: { to }.
//
// Unlike the Meta path, the SDP is NOT sent here: waha-voip places the call
// first (which rings the customer), then the browser negotiates its mic/audio
// separately via POST /api/calls/waha/{callId}/webrtc. So this route just
// resolves the canonical chatId (the LID fix) and calls /calls/start.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  wahaCallsForAccount,
  wahaCallsPost,
  resolveCallChatId,
} from '@/lib/channels/waha-calls'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as { to?: string }
    if (!body.to) {
      return NextResponse.json({ error: 'to required' }, { status: 400 })
    }

    const coords = await wahaCallsForAccount(ctx.accountId)
    if (!coords) {
      return NextResponse.json(
        { error: 'No WAHA calls engine configured' },
        { status: 400 },
      )
    }

    // LID fix — resolve to the canonical chatId or the call never rings.
    const chatId = await resolveCallChatId(coords, body.to)
    if (!chatId) {
      return NextResponse.json(
        { error: 'number not reachable on WhatsApp' },
        { status: 422 },
      )
    }

    const r = await wahaCallsPost(coords, 'start', { to: chatId })
    if (!r.ok) {
      console.error('[waha-calls] start failed', r.status, JSON.stringify(r.data))
      return NextResponse.json(
        { error: 'start failed', data: r.data },
        { status: 502 },
      )
    }

    const callId = (r.data as { id?: string }).id ?? null
    return NextResponse.json({ ok: true, callId, chatId })
  } catch (err) {
    return toErrorResponse(err)
  }
}

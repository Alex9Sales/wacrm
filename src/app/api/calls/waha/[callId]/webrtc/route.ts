// ============================================================
// POST /api/calls/waha/{callId}/webrtc — exchange the browser WebRTC SDP for
// an in-progress waha-voip call. Body: { sdpOffer }. Returns { sdpAnswer }.
//
// waha-voip answers the browser offer and wires the PCM audio path
// (browser mic → call, peer audio → browser). Called right after
// /api/calls/waha/initiate returns a callId (outbound), or after accepting an
// inbound call.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { wahaCallsForAccount, wahaCallsPost } from '@/lib/channels/waha-calls'

interface RouteParams {
  params: Promise<{ callId: string }>
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { callId } = await params
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      sdpOffer?: string
    }
    if (!body.sdpOffer) {
      return NextResponse.json({ error: 'sdpOffer required' }, { status: 400 })
    }

    const coords = await wahaCallsForAccount(ctx.accountId)
    if (!coords) {
      return NextResponse.json(
        { error: 'No WAHA calls engine configured' },
        { status: 400 },
      )
    }

    const r = await wahaCallsPost(coords, `${encodeURIComponent(callId)}/webrtc`, {
      sdpOffer: body.sdpOffer,
    })
    if (!r.ok) {
      console.error('[waha-calls] webrtc failed', r.status, JSON.stringify(r.data))
      return NextResponse.json(
        { error: 'webrtc failed', data: r.data },
        { status: 502 },
      )
    }

    const sdpAnswer = (r.data as { sdpAnswer?: string }).sdpAnswer ?? null
    return NextResponse.json({ ok: true, sdpAnswer })
  } catch (err) {
    return toErrorResponse(err)
  }
}

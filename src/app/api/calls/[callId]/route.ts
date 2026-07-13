// ============================================================
// POST /api/calls/{callId} — control a WhatsApp voice call (Meta Business
// Calling API). Body: { action, sdp?, to? }.
//   - accept:    sends pre_accept then accept, both carrying our SDP answer
//   - reject:    declines a ringing call
//   - terminate: ends an active call
//
// The browser holds the WebRTC media (mic/speaker) and produces the SDP
// answer; this route only relays the signaling to Meta with the channel's
// token (server-side — the token never reaches the browser). Auth: any
// signed-in member of the account.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { loadMetaChannelByPhoneNumberId } from '@/lib/channels/channels'

const GRAPH = 'https://graph.facebook.com/v21.0'

type Action = 'accept' | 'reject' | 'terminate'

async function metaCall(
  phoneNumberId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${GRAPH}/${phoneNumberId}/calls`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ callId: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { callId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      action?: Action
      sdp?: string
      to?: string
    }
    const action = body.action
    if (action !== 'accept' && action !== 'reject' && action !== 'terminate') {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    // The account's Meta channel → phone_number_id + decrypted token.
    const row = firstOrNull(
      await db
        .select({
          pnid: sql<string>`${channels.providerMeta}->>'phone_number_id'`,
        })
        .from(channels)
        .where(
          and(
            eq(channels.accountId, ctx.accountId),
            eq(channels.provider, 'meta'),
          ),
        )
        .limit(1),
    )
    if (!row?.pnid) {
      return NextResponse.json(
        { error: 'No Meta channel connected' },
        { status: 400 },
      )
    }
    const channel = await loadMetaChannelByPhoneNumberId(row.pnid)
    const token = channel?.credentials.accessToken as string | undefined
    if (!channel || !token) {
      return NextResponse.json(
        { error: 'Meta channel credentials unavailable' },
        { status: 400 },
      )
    }
    const phoneNumberId = row.pnid

    if (action === 'reject' || action === 'terminate') {
      const r = await metaCall(phoneNumberId, token, {
        messaging_product: 'whatsapp',
        call_id: callId,
        action,
      })
      return NextResponse.json({ ok: r.ok, data: r.data }, { status: r.ok ? 200 : 502 })
    }

    // accept: needs the browser's SDP answer.
    if (!body.sdp || !body.to) {
      return NextResponse.json(
        { error: 'accept requires sdp and to' },
        { status: 400 },
      )
    }
    const session = { sdp: body.sdp, sdp_type: 'answer' }
    // Pre-accept first (opens the media path early), then accept.
    const pre = await metaCall(phoneNumberId, token, {
      messaging_product: 'whatsapp',
      to: body.to,
      call_id: callId,
      action: 'pre_accept',
      session,
    })
    if (!pre.ok) {
      console.error('[calls] pre_accept failed', pre.status, JSON.stringify(pre.data))
      return NextResponse.json({ error: 'pre_accept failed', data: pre.data }, { status: 502 })
    }
    const acc = await metaCall(phoneNumberId, token, {
      messaging_product: 'whatsapp',
      to: body.to,
      call_id: callId,
      action: 'accept',
      session,
    })
    if (!acc.ok) {
      console.error('[calls] accept failed', acc.status, JSON.stringify(acc.data))
      return NextResponse.json({ error: 'accept failed', data: acc.data }, { status: 502 })
    }
    return NextResponse.json({ ok: true, data: acc.data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

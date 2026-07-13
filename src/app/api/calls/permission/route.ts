// ============================================================
// POST /api/calls/permission — ask a customer for permission to call them
// (WhatsApp requires this before a business-initiated call). Sends a
// `call_permission_request` interactive message. Only works inside an open
// 24h conversation window; Meta rate-limits it (1/day, 2/7d).
// Body: { to, text? }.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  metaChannelForAccount,
  graphPost,
} from '@/lib/channels/meta-channel-for-account'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as {
      to?: string
      text?: string
    }
    if (!body.to) {
      return NextResponse.json({ error: 'to required' }, { status: 400 })
    }
    const ch = await metaChannelForAccount(ctx.accountId)
    if (!ch) {
      return NextResponse.json({ error: 'No Meta channel' }, { status: 400 })
    }

    const r = await graphPost(ch.phoneNumberId, ch.token, 'messages', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: body.to,
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: {
          text:
            body.text ??
            'Podemos te ligar por aqui pelo WhatsApp para agilizar seu atendimento?',
        },
      },
    })

    if (!r.ok) {
      console.error('[calls] permission request failed', r.status, JSON.stringify(r.data))
      return NextResponse.json({ error: 'permission failed', data: r.data }, { status: 502 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

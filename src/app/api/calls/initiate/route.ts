// ============================================================
// POST /api/calls/initiate — start an OUTBOUND WhatsApp voice call (business
// → customer). Body: { to, sdp }. The browser generates the WebRTC offer;
// this relays it to Meta with action:'connect'. Meta returns the call_id;
// the customer's SDP answer arrives later via the `calls` webhook (which
// publishes a `call_answer` SSE event the modal picks up).
//
// If the business lacks call permission, Meta rejects it — we surface
// { needsPermission: true } so the UI can offer to request permission.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { getAccountSettings } from '@/lib/settings/account-settings'
import {
  metaChannelForAccount,
  graphPost,
} from '@/lib/channels/meta-channel-for-account'

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    // Master switch: block outbound when the admin disabled CRM calling.
    const settings = await getAccountSettings(ctx.accountId)
    if (!settings.crmCallingEnabled) {
      return NextResponse.json(
        {
          error:
            'Ligações desativadas pelo administrador. Reative em Configurações → Notificações.',
          code: 'calling_disabled',
        },
        { status: 403 },
      )
    }

    const body = (await request.json().catch(() => ({}))) as {
      to?: string
      sdp?: string
    }
    if (!body.to || !body.sdp) {
      return NextResponse.json({ error: 'to and sdp required' }, { status: 400 })
    }

    const ch = await metaChannelForAccount(ctx.accountId)
    if (!ch) {
      return NextResponse.json({ error: 'No Meta channel' }, { status: 400 })
    }

    const r = await graphPost(ch.phoneNumberId, ch.token, 'calls', {
      messaging_product: 'whatsapp',
      to: body.to,
      action: 'connect',
      session: { sdp_type: 'offer', sdp: body.sdp },
    })

    if (!r.ok) {
      console.error('[calls] connect failed', r.status, JSON.stringify(r.data))
      // Detect a permission-related rejection so the UI can offer to ask.
      const raw = JSON.stringify(r.data).toLowerCase()
      const needsPermission =
        raw.includes('permission') || raw.includes('not allowed to call')
      return NextResponse.json(
        { error: 'connect failed', needsPermission, data: r.data },
        { status: 502 },
      )
    }

    // Meta returns the new call id under data.calls[0].id.
    const data = r.data as { calls?: Array<{ id?: string }> }
    const callId = data.calls?.[0]?.id ?? null
    return NextResponse.json({ ok: true, callId })
  } catch (err) {
    return toErrorResponse(err)
  }
}

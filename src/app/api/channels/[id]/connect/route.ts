// ============================================================
// Channel connect / QR pairing route (Phase 4, wave 4A).
//
//   POST /api/channels/:id/connect
//
// Starts a session on a non-official provider (waha / evolution / evogo)
// and returns the pairing QR. Meta has no QR pairing → 400.
//
// The webhook URL we register with the provider carries the per-channel
// secret in the QUERY string:
//   ${origin}/api/webhooks/${provider}/${id}?secret=${webhookSecret}
// The generic webhook route validates that `?secret=` (see
// src/app/api/webhooks/[provider]/[channelId]/route.ts). Origin resolves
// from NEXT_PUBLIC_SITE_URL, falling back to the request origin — WAHA on a
// remote VPS can't reach localhost, so live pairing needs a public URL (a
// deploy concern, not a code bug).
//
// QR shape: `{ qr, qrIsImage }`. waha/evolution return a
// `data:image/png;base64,...` (qrIsImage = true); evogo returns a raw QR
// STRING starting with '2@' the UI must encode itself (qrIsImage = false).
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannelByAccount, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'

interface RouteParams {
  params: Promise<{ id: string }>
}

/** Resolve the public origin: NEXT_PUBLIC_SITE_URL first, else the request. */
function resolveOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured && configured.trim().length > 0) {
    return configured.replace(/\/+$/, '')
  }
  return new URL(request.url).origin
}

export async function POST(request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const channel = await loadChannelByAccount(ctx.accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    if (channel.provider === 'meta') {
      return NextResponse.json(
        { error: 'Canal Meta não usa QR' },
        { status: 400 },
      )
    }

    const provider = getProvider(channel.provider)
    if (!provider.startSession) {
      return NextResponse.json(
        { error: `Provider "${channel.provider}" does not support QR pairing` },
        { status: 400 },
      )
    }

    // Build the webhook URL with the per-channel secret in the query — the
    // generic webhook route validates it from there (providers only POST to
    // the URL; they don't send our custom header).
    const origin = resolveOrigin(request)
    const webhookUrl = `${origin}/api/webhooks/${channel.provider}/${channel.id}?secret=${encodeURIComponent(channel.webhookSecret)}`

    const { qr } = await provider.startSession(channel, webhookUrl)

    // Mark the channel as awaiting a scan.
    await updateChannelStatus(channel.id, 'qr_pending')

    if (!qr) {
      // Session started but no QR this round (still initializing, or already
      // paired). The UI should poll /state.
      return NextResponse.json({ qr: null, qrIsImage: false })
    }

    // waha/evolution return a data:image/... URL; evogo returns a raw
    // string (starts with '2@'). Flag which so the UI renders an <img> or
    // encodes the string into a QR itself.
    const qrIsImage = qr.startsWith('data:')
    return NextResponse.json({ qr, qrIsImage })
  } catch (err) {
    return toErrorResponse(err)
  }
}

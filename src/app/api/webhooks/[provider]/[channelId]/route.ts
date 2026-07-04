// ============================================================
// Generic non-official-provider webhook route (Phase 4, wave 3A).
//
// One route serves WAHA, Evolution, and EvoGo:
//   POST /api/webhooks/:provider/:channelId
//
// Flow:
//   1. Load the channel by id (loadChannel) and assert channel.provider
//      matches the :provider path segment.
//   2. Verify the webhook via getProvider(provider).verifyWebhook — the
//      non-official adapters check the per-channel secret against the
//      `x-webhook-secret` header → 401 on failure.
//   3. Session-lifecycle events (WAHA session.status, Evolution
//      CONNECTION_UPDATE, EvoGo Connected/Disconnected) update
//      channels.status via getState + updateChannelStatus, then return —
//      no message processing.
//   4. Otherwise parseWebhook → for each NormalizedInbound, resolve inbound
//      media bytes via fetchInboundMedia when the media lacks base64/url,
//      then dispatchInboundMessage(channel, ev). Statuses mirror through the
//      shared status helper (channels/status.ts), identical to Meta.
//
// Heavy work runs in `after()` so we 200 quickly (the non-official gateways
// retry aggressively on a slow ack).
// ============================================================

import { NextResponse, after } from 'next/server'

import { loadChannel, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { applyStatusUpdate, levelToStatus } from '@/lib/channels/status'
import type { ProviderId, WhatsAppProvider } from '@/lib/channels/provider'

const NON_OFFICIAL: ReadonlySet<ProviderId> = new Set([
  'waha',
  'evolution',
  'evogo',
])

interface RouteParams {
  params: Promise<{ provider: string; channelId: string }>
}

export async function POST(request: Request, { params }: RouteParams) {
  const { provider: providerParam, channelId } = await params

  // Only the non-official providers use this route; Meta has its own.
  if (!NON_OFFICIAL.has(providerParam as ProviderId)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 404 })
  }
  const providerId = providerParam as ProviderId

  const rawBody = await request.text()

  const channel = await loadChannel(channelId)
  if (!channel) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
  }
  // The channel's provider must match the path — otherwise a WAHA channel id
  // posted to /evolution/... would parse with the wrong adapter.
  if (channel.provider !== providerId) {
    return NextResponse.json(
      { error: 'Channel/provider mismatch' },
      { status: 404 },
    )
  }

  const provider = getProvider(providerId)

  // Verify the per-channel secret (x-webhook-secret header).
  const verified = await provider.verifyWebhook(
    { rawBody, headers: request.headers },
    channel,
  )
  if (!verified) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Session-lifecycle events update channels.status and skip messages. Do
  // this synchronously (it's cheap + we want the status current) before the
  // 200. getState re-reads the authoritative state from the gateway so we
  // don't have to re-implement each provider's state mapping here.
  if (isSessionStateEvent(providerId, body)) {
    try {
      if (provider.getState) {
        const { status } = await provider.getState(channel)
        await updateChannelStatus(channel.id, status)
      }
    } catch (err) {
      console.error('[webhooks/generic] session-state update failed:', err)
    }
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  }

  // Message + status processing runs after the ack.
  after(async () => {
    try {
      await processInbound(provider, channel.id, body)
    } catch (err) {
      console.error('[webhooks/generic] processing failed:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processInbound(
  provider: WhatsAppProvider,
  channelId: string,
  body: unknown,
) {
  // Re-load the channel inside `after()` so we hold a fresh decrypted ctx.
  const channel = await loadChannel(channelId)
  if (!channel) return

  const { messages, statuses } = provider.parseWebhook(body)

  // ---- statuses (delivered/read) ----
  for (const st of statuses) {
    await applyStatusUpdate({
      externalMessageId: st.externalMessageId,
      status: levelToStatus(st.level),
    })
  }

  // ---- inbound messages ----
  for (const ev of messages) {
    // Resolve inbound media bytes when the webhook didn't inline them
    // (WAHA/Evolution deliver a fetchKey; EvoGo has no fetch — inboundMedia
    // is false there and the pipeline stores a text placeholder).
    if (
      ev.media &&
      ev.media.fetchKey &&
      !ev.media.base64 &&
      !ev.media.url &&
      provider.fetchInboundMedia
    ) {
      try {
        const fetched = await provider.fetchInboundMedia(channel, ev.media.fetchKey)
        if (fetched) {
          ev.media.base64 = fetched.base64
          ev.media.mimetype = ev.media.mimetype ?? fetched.mimetype
        }
      } catch (err) {
        console.error('[webhooks/generic] fetchInboundMedia failed:', err)
      }
    }
    try {
      await dispatchInboundMessage(channel, ev)
    } catch (err) {
      console.error('[webhooks/generic] dispatchInboundMessage failed:', err)
    }
  }
}

/**
 * Detect a session/connection lifecycle event from the raw body per
 * provider. These carry no NormalizedInbound/NormalizedStatus — the route
 * refreshes channels.status via getState rather than parsing state here.
 *   - WAHA:      { event: 'session.status', ... }
 *   - Evolution: { event: 'CONNECTION_UPDATE', ... }
 *   - EvoGo:     { event: 'Connected' | 'Disconnected' | 'LoggedOut', ... }
 */
function isSessionStateEvent(provider: ProviderId, body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const event = String((body as { event?: unknown }).event ?? '')
  switch (provider) {
    case 'waha':
      return event === 'session.status'
    case 'evolution':
      return event === 'CONNECTION_UPDATE'
    case 'evogo':
      return (
        event === 'Connected' ||
        event === 'Disconnected' ||
        event === 'LoggedOut'
      )
    default:
      return false
  }
}

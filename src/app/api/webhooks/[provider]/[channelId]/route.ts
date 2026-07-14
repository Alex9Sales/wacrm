// ============================================================
// Generic non-official-provider webhook route (Phase 4, wave 3A).
//
// One route serves WAHA, Evolution, and EvoGo:
//   POST /api/webhooks/:provider/:channelId
//
// Flow:
//   1. Load the channel by id (loadChannel) and assert channel.provider
//      matches the :provider path segment.
//   2. Verify the webhook secret. The /connect route registers the URL
//      with the secret in the QUERY (`?secret=<webhook_secret>`) because the
//      gateways only POST to the URL and don't send our header. We accept
//      the secret from `?secret=` (constant-time compare vs channel
//      .webhookSecret) OR, as a fallback, the provider's header-based
//      verifyWebhook (`x-webhook-secret`) → 401 on failure.
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

import crypto from 'crypto'

import { NextResponse, after } from 'next/server'
import { and, eq, ne } from 'drizzle-orm'

import { db, callLogs, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { applyStatusUpdate, levelToStatus } from '@/lib/channels/status'
import type { ProviderId, WhatsAppProvider } from '@/lib/channels/provider'
import { publishEvent } from '@/lib/events/publish'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

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

  // ---- webhook auth: secret in the QUERY *or* the header ----
  //
  // The /connect route registers the webhook URL with the per-channel
  // secret in the query string (`?secret=<webhook_secret>`), because the
  // non-official gateways just POST to that URL — they do NOT send our
  // custom `x-webhook-secret` header. So we accept the secret from the
  // query and validate it here with a constant-time compare against
  // channel.webhookSecret. If it matches we short-circuit; otherwise we
  // fall back to the provider's header-based verifyWebhook so a manually
  // configured `x-webhook-secret` header keeps working too.
  const querySecret = new URL(request.url).searchParams.get('secret')
  let verified = false
  if (querySecret != null && secretsMatch(querySecret, channel.webhookSecret)) {
    verified = true
  } else {
    verified = await provider.verifyWebhook(
      { rawBody, headers: request.headers },
      channel,
    )
  }
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
        const { status, phoneNumber } = await provider.getState(channel)
        // Persist the paired number when the provider reports one (WAHA
        // surfaces it once WORKING) so the channel stops showing
        // "Número não vinculado". Passing undefined leaves it unchanged.
        await updateChannelStatus(
          channel.id,
          status,
          phoneNumber ?? undefined,
        )
        // Fan the new session state out to open tabs so the global
        // "channel down — reconnect" banner reacts live (appears on a
        // drop/ban, clears once it's WORKING again).
        await publishEvent(channel.accountId, {
          type: 'channel_status',
          channelId: channel.id,
          name: channel.name,
          status,
        })
      }
    } catch (err) {
      console.error('[webhooks/generic] session-state update failed:', err)
    }
    return NextResponse.json({ status: 'ok' }, { status: 200 })
  }

  // waha-voip native call events (unofficial calling). call.received rings
  // the global call modal via SSE and records a 'missed' history row (the
  // panel's source of truth for calls nobody saw); accepted/rejected
  // promotes that row and dismisses the modal. No message processing.
  if (providerId === 'waha') {
    const ev = body as {
      event?: string
      payload?: { id?: string; from?: string; isGroup?: boolean }
    }
    if (typeof ev?.event === 'string' && ev.event.startsWith('call.')) {
      const callId = ev.payload?.id ?? ''
      if (ev.event === 'call.received' && callId && !ev.payload?.isGroup) {
        const rawFrom = String(ev.payload?.from ?? '')
        // TEMP diagnostic: capture the raw shape once so we can learn where
        // gows hides the caller's real phone for @lid callers (name +
        // call-back in the Ligações panel). Remove after confirming.
        if (/@lid$/.test(rawFrom)) {
          console.log(
            '[webhooks/generic] call.received @lid payload:',
            JSON.stringify(ev.payload).slice(0, 1500),
          )
        }
        // @lid callers can't be reduced to a phone here — pass the raw
        // chatId; reject needs it verbatim and the modal falls back to it
        // for display.
        await publishEvent(channel.accountId, {
          type: 'call_incoming',
          callId,
          from: rawFrom,
          provider: 'waha',
          channelId: channel.id,
        })
        try {
          // Born 'missed' — promoted by call.accepted/rejected below. The
          // partial unique index (account, external_call_id) absorbs the
          // webhook retries.
          // Strip the multi-device suffix (":9") before reducing to digits.
          const digits = /@(c\.us|s\.whatsapp\.net)$/.test(rawFrom)
            ? rawFrom.split('@')[0].split(':')[0].replace(/\D/g, '')
            : ''
          const contact = digits
            ? firstOrNull(
                await db
                  .select({ id: contacts.id })
                  .from(contacts)
                  .where(
                    and(
                      eq(contacts.accountId, channel.accountId),
                      eq(contacts.phoneNormalized, normalizePhone(digits)),
                    ),
                  )
                  .limit(1),
              )
            : null
          await db
            .insert(callLogs)
            .values({
              accountId: channel.accountId,
              channelId: channel.id,
              contactId: contact?.id ?? null,
              peer: rawFrom,
              direction: 'in',
              status: 'missed',
              provider: 'waha',
              externalCallId: callId,
            })
            .onConflictDoNothing()
        } catch (err) {
          console.error('[webhooks/generic] call-log insert failed:', err)
        }
      } else if (
        (ev.event === 'call.accepted' || ev.event === 'call.rejected') &&
        callId
      ) {
        await publishEvent(channel.accountId, {
          type: 'call_status',
          callId,
          status: ev.event === 'call.accepted' ? 'ACCEPTED_ELSEWHERE' : 'REJECTED',
        })
        try {
          // Promote-only: gows fires call.rejected when the PEER HANGS UP an
          // active call too — that must never downgrade an answered call
          // back to "não atendida".
          const where =
            ev.event === 'call.accepted'
              ? and(
                  eq(callLogs.accountId, channel.accountId),
                  eq(callLogs.externalCallId, callId),
                )
              : and(
                  eq(callLogs.accountId, channel.accountId),
                  eq(callLogs.externalCallId, callId),
                  ne(callLogs.status, 'answered'),
                )
          await db
            .update(callLogs)
            .set({
              status: ev.event === 'call.accepted' ? 'answered' : 'rejected',
              updatedAt: new Date().toISOString(),
            })
            .where(where)
        } catch (err) {
          console.error('[webhooks/generic] call-log update failed:', err)
        }
      }
      return NextResponse.json({ status: 'ok' }, { status: 200 })
    }
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

/**
 * Constant-time comparison of two secrets. Encodes both to bytes and uses
 * crypto.timingSafeEqual, guarding the length-mismatch case (which
 * timingSafeEqual throws on) without leaking length via early-return
 * timing — we still run a comparison against a same-length buffer.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Compare b against itself so the work is constant regardless of the
    // provided length, then return false.
    crypto.timingSafeEqual(b, b)
    return false
  }
  return crypto.timingSafeEqual(a, b)
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

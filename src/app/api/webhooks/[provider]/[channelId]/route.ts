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
import { and, eq, isNull, ne } from 'drizzle-orm'

import { db, callLogs, contacts, conversations, messages, messageReactions } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadChannel, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { applyStatusUpdate, levelToStatus } from '@/lib/channels/status'
import type {
  ChannelCtx,
  NormalizedDeletion,
  NormalizedReaction,
  ProviderId,
  WhatsAppProvider,
} from '@/lib/channels/provider'
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
      payload?: {
        id?: string
        from?: string
        isGroup?: boolean
        isVideo?: boolean
        _data?: {
          CallCreatorAlt?: string
          Data?: { Attrs?: { caller_pn?: string } }
        }
      }
    }
    if (typeof ev?.event === 'string' && ev.event.startsWith('call.')) {
      const callId = ev.payload?.id ?? ''
      // VÍDEO: o CRM só faz voz. Uma chamada de vídeo NÃO deve tocar o modal de
      // voz (o operador atenderia numa ligação que nunca teria vídeo). Ignoramos
      // aqui — a chamada segue tocando no WhatsApp do dono pra ele atender com
      // vídeo de verdade. Mesma regra do bridge da IA (payload.isVideo).
      if (
        ev.event === 'call.received' &&
        callId &&
        !ev.payload?.isGroup &&
        ev.payload?.isVideo !== true
      ) {
        const rawFrom = String(ev.payload?.from ?? '')
        // gows hides the caller's real phone for @lid callers in
        // _data.CallCreatorAlt (or Data.Attrs.caller_pn), both
        // @s.whatsapp.net — use it for display / contact / call-back. The
        // raw @lid still goes to the modal (reject needs it verbatim).
        const altJid = String(
          ev.payload?._data?.CallCreatorAlt ||
            ev.payload?._data?.Data?.Attrs?.caller_pn ||
            '',
        )
        const phoneSource = /@(c\.us|s\.whatsapp\.net)$/.test(altJid)
          ? altJid
          : /@(c\.us|s\.whatsapp\.net)$/.test(rawFrom)
            ? rawFrom
            : ''
        const digits = phoneSource
          ? phoneSource.split('@')[0].split(':')[0].replace(/\D/g, '')
          : ''
        const contact = digits
          ? firstOrNull(
              await db
                .select({ id: contacts.id, name: contacts.name })
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
        // Prefer the real phone JID as the modal/panel peer; keep the @lid
        // as callerLid so reject still targets the right chatId.
        const displayFrom = digits ? `${digits}@c.us` : rawFrom

        // No busy check: every incoming call rings. A "channel busy" overflow
        // used to reject a second caller here and reply "estamos em
        // atendimento", built on the belief that WhatsApp allows ONE active
        // call per number. That belief was deduced, never tested, and a live
        // test on 16/07 killed it: two customers called the same channel and
        // BOTH were answered in the CRM, with audio — answering the second put
        // the first on hold (alive), and hanging up the second came back to a
        // working call. gows multiplexes calls on one number.
        //
        // So the overflow was rejecting calls that could have been answered,
        // while the agent's phone rang anyway — it told the customer we were
        // busy and prevented nothing. Removing it also kills the bug class it
        // caused: since gows emits NO "ended" event, a call answered on the
        // phone never closed its row, and the busy check then read that stale
        // row as a live call and wedged the channel for 30 minutes.
        await publishEvent(channel.accountId, {
          type: 'call_incoming',
          callId,
          from: displayFrom,
          callerName: contact?.name ?? undefined,
          callerLid: /@lid$/.test(rawFrom) ? rawFrom : undefined,
          provider: 'waha',
          channelId: channel.id,
        })
        try {
          await db
            .insert(callLogs)
            .values({
              accountId: channel.accountId,
              channelId: channel.id,
              contactId: contact?.id ?? null,
              peer: displayFrom,
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
          // gows fires call.rejected both for a decline AND when the peer
          // hangs up a live call — either way the leg is over, so stamp
          // ended_at (separate from the promote-only status update above, which
          // deliberately skips answered rows) and free the channel.
          if (ev.event === 'call.rejected') {
            const now = new Date().toISOString()
            await db
              .update(callLogs)
              .set({ endedAt: now, updatedAt: now })
              .where(
                and(
                  eq(callLogs.accountId, channel.accountId),
                  eq(callLogs.externalCallId, callId),
                  isNull(callLogs.endedAt),
                ),
              )
          }
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

  const {
    messages: inbound,
    statuses,
    reactions,
    deletions,
  } = provider.parseWebhook(body)

  // ---- statuses (delivered/read) ----
  for (const st of statuses) {
    await applyStatusUpdate({
      externalMessageId: st.externalMessageId,
      status: levelToStatus(st.level),
    })
  }

  // ---- customer reactions ----
  for (const rx of reactions ?? []) {
    try {
      await applyInboundReaction(channel, rx)
    } catch (err) {
      console.error('[webhooks/generic] reaction failed:', err)
    }
  }

  // ---- deletions (revoked on WhatsApp) ----
  for (const del of deletions ?? []) {
    try {
      await applyInboundDeletion(channel, del)
    } catch (err) {
      console.error('[webhooks/generic] deletion failed:', err)
    }
  }

  // ---- inbound messages ----
  for (const ev of inbound) {
    // A 1:1 message addressed only by @lid carries no phone — resolve it to the
    // real phone via the provider's LID→PN map so it lands in the right contact
    // thread instead of being lost. If it can't be resolved, skip (the old drop
    // behaviour) rather than spawn a bogus lid-keyed contact.
    if (ev.senderLid && !ev.fromPhoneE164) {
      if (provider.resolveLidToPhone) {
        try {
          const phone = await provider.resolveLidToPhone(channel, ev.senderLid)
          if (phone) ev.fromPhoneE164 = phone
        } catch (err) {
          console.error('[webhooks/generic] resolveLidToPhone failed:', err)
        }
      }
      if (!ev.fromPhoneE164) {
        console.error(
          '[webhooks/generic] inbound @lid unresolvable, dropping:',
          ev.senderLid,
        )
        continue
      }
    }
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

/** Resolve a reacted-to / deleted message to its internal row, account-scoped. */
async function findTargetMessage(
  accountId: string,
  externalId: string,
): Promise<{ id: string; conversationId: string } | null> {
  return firstOrNull(
    await db
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(
        and(
          eq(messages.messageId, externalId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1),
  )
}

/**
 * Persist a customer's emoji reaction (upsert; empty emoji removes it), then
 * ping the open thread to refresh. Skips our own reaction echoes (fromMe) —
 * the agent-side path already stored those.
 */
async function applyInboundReaction(
  channel: ChannelCtx,
  rx: NormalizedReaction,
) {
  if (rx.fromMe) return
  const target = await findTargetMessage(channel.accountId, rx.targetExternalId)
  if (!target) return

  const actor = rx.fromPhoneE164
    ? await findExistingContact(channel.accountId, normalizePhone(rx.fromPhoneE164))
    : null
  if (!actor) return // can't attribute the reaction to a contact

  if (!rx.emoji) {
    await db
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, target.id),
          eq(messageReactions.actorType, 'customer'),
          eq(messageReactions.actorId, actor.id),
        ),
      )
  } else {
    await db
      .insert(messageReactions)
      .values({
        messageId: target.id,
        conversationId: target.conversationId,
        actorType: 'customer',
        actorId: actor.id,
        emoji: rx.emoji,
      })
      .onConflictDoUpdate({
        target: [
          messageReactions.messageId,
          messageReactions.actorType,
          messageReactions.actorId,
        ],
        set: { emoji: rx.emoji },
      })
  }

  // Bump the open thread (refetches messages + reactions). fromMe avoids the
  // unread/notification side effects of a real inbound.
  await publishEvent(channel.accountId, {
    type: 'message.received',
    conversationId: target.conversationId,
    fromMe: true,
  })
}

/** Mark a message deleted (revoked on WhatsApp) so the CRM shows "apagada". */
async function applyInboundDeletion(
  channel: ChannelCtx,
  del: NormalizedDeletion,
) {
  const target = await findTargetMessage(channel.accountId, del.targetExternalId)
  if (!target) return
  await db
    .update(messages)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(messages.id, target.id))
  await publishEvent(channel.accountId, {
    type: 'message.received',
    conversationId: target.conversationId,
    fromMe: true,
  })
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

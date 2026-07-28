// ============================================================
// Meta (official WhatsApp Cloud API) webhook route (Phase 4, wave 3A).
//
// Ported from /api/whatsapp/webhook — the legacy Meta-coupled route — but
// re-plumbed onto the Phase 4 channel abstraction:
//   * GET verify-challenge resolves the verify_token against Meta channels
//     (channels.credentials.verifyToken) instead of whatsapp_config.
//   * POST verifies the HMAC via metaProvider.verifyWebhook, resolves the
//     channel by phone_number_id (loadMetaChannelByPhoneNumberId), parses
//     the body via metaProvider.parseWebhook, fetches inbound media bytes
//     via metaProvider.fetchInboundMedia, and hands every NormalizedInbound
//     to the agnostic pipeline dispatchInboundMessage(channel, ev).
//   * Statuses mirror through the shared status helper (channels/status.ts).
//   * Template-lifecycle events still route to handleTemplateWebhookChange.
//   * Reactions are handled here (the pipeline / parseWebhook drop them, as
//     reactions are per-(target, actor) state, not messages).
//
// Heavy processing runs inside `after()` so we ack Meta within their ~20s
// window while guaranteeing the work runs to completion on serverless.
// ============================================================

import { NextResponse, after } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db, callLogs, channels, contacts, conversations, messageReactions, messages } from '@/db'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { buildCallLog } from '@/lib/inbox/call-log'
import { firstOrNull } from '@/db/helpers'
import { decryptCredentials, loadMetaChannelByPhoneNumberId } from '@/lib/channels/channels'
import { metaProvider } from '@/lib/channels/providers/meta'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { applyStatusUpdate } from '@/lib/channels/status'
import { publishEvent } from '@/lib/events/publish'
import type { ChannelCtx } from '@/lib/channels/provider'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback fans out to per-media Meta fetches, so give it
// headroom (Vercel clamps this to the plan ceiling).
export const maxDuration = 60

// ------------------------------------------------------------
// Minimal raw-webhook shapes (only what the route reads directly — the
// provider owns full parsing).
// ------------------------------------------------------------

interface MetaRawStatus {
  id: string
  status: string
  timestamp?: string
  recipient_id?: string
}

interface MetaRawReaction {
  message_id: string
  emoji: string
}

interface MetaRawMessage {
  id: string
  from: string
  type: string
  reaction?: MetaRawReaction
}

interface MetaRawContact {
  profile?: { name?: string }
  wa_id?: string
}

interface MetaRawCall {
  id?: string
  from?: string
  to?: string
  event?: string // 'connect' (incoming) | 'terminate'
  direction?: string
  status?: string // on terminate: COMPLETED | REJECTED | FAILED
  duration?: number
  session?: { sdp?: string; sdp_type?: string }
}

// COEXISTÊNCIA: mensagem que o NEGÓCIO enviou (do app WhatsApp Business no
// celular ou de um aparelho vinculado). `from` = número do negócio, `to` =
// cliente. Vem no campo `smb_message_echoes` (array `message_echoes`).
interface MetaEchoMessage {
  from?: string
  to?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  [key: string]: unknown
}

interface MetaRawValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string }
  contacts?: MetaRawContact[]
  messages?: MetaRawMessage[]
  statuses?: MetaRawStatus[]
  calls?: MetaRawCall[]
  message_echoes?: MetaEchoMessage[]
}

interface MetaRawChange {
  field?: string
  value?: MetaRawValue
}

interface MetaRawEntry {
  id?: string
  changes?: MetaRawChange[]
}

interface MetaRawBody {
  entry?: MetaRawEntry[]
}

// ------------------------------------------------------------
// GET — webhook verification (hub.challenge).
// ------------------------------------------------------------
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 },
      )
    }

    // Match the verify_token against every Meta channel's decrypted
    // credentials.verifyToken. A malformed / wrong-key row is skipped.
    let metaChannels: { id: string; credentials: string }[]
    try {
      metaChannels = await db
        .select({ id: channels.id, credentials: channels.credentials })
        .from(channels)
        .where(eq(channels.provider, 'meta'))
    } catch (err) {
      console.error('[webhooks/meta] Error fetching channels for verification:', err)
      return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
    }

    for (const ch of metaChannels) {
      try {
        const creds = decryptCredentials(ch.credentials)
        if (typeof creds.verifyToken === 'string' && creds.verifyToken === verifyToken) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        }
      } catch {
        // Unreadable credentials — skip and keep checking.
      }
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 },
    )
  } catch (error) {
    console.error('[webhooks/meta] Error in GET verification:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ------------------------------------------------------------
// POST — receive messages / statuses / template events.
// ------------------------------------------------------------
export async function POST(request: Request) {
  // Read the raw body first so we HMAC-verify the exact bytes Meta signed.
  const rawBody = await request.text()

  // Parse BEFORE verifying so we can resolve the channel by phone_number_id
  // and verify with THAT channel's App Secret (multi-tenant: a client running
  // their own Meta App signs with their own secret; channels without a
  // per-channel secret fall back to the global META_APP_SECRET). This is safe:
  // we only read phone_number_id to PICK which secret to check — nothing in
  // the body is trusted or acted on until the signature passes below. An
  // attacker can't benefit from naming any phone_number_id, since they still
  // can't produce a valid signature for that channel's secret.
  let body: MetaRawBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const pnid =
    body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id
  const sigChannel = pnid
    ? await loadMetaChannelByPhoneNumberId(pnid)
    : null

  const verified = await metaProvider.verifyWebhook(
    { rawBody, headers: request.headers },
    sigChannel,
  )
  if (!verified) {
    console.warn('[webhooks/meta] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout.
  after(async () => {
    try {
      await processWebhook(body)
    } catch (error) {
      console.error('[webhooks/meta] Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

async function processWebhook(body: MetaRawBody) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      // Template-lifecycle events (status / quality / components) come in on
      // a different change.field with a different value shape.
      if (change.field && isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange({
          field: change.field,
          value: change.value as unknown,
        })
        continue
      }

      const value = change.value
      if (!value) continue

      // ---- COEXISTÊNCIA: mensagens que o NEGÓCIO enviou (do celular/app) ----
      // Sem isto, uma resposta feita pelo WhatsApp do celular não apareceria no
      // CRM — que é justamente o ponto da coexistência (celular + CRM juntos).
      if (change.field === 'smb_message_echoes') {
        await handleMessageEchoes(value)
        continue
      }

      // ---- statuses ----
      if (Array.isArray(value.statuses)) {
        for (const status of value.statuses) {
          if (!status.id) continue
          await applyStatusUpdate({
            externalMessageId: status.id,
            status: status.status,
            timestampSeconds: status.timestamp
              ? parseInt(status.timestamp, 10)
              : undefined,
          })
        }
      }

      // ---- voice calls (WhatsApp Business Calling API) ----
      // 'connect' = an inbound call is ringing (carries the caller's SDP
      // offer in session.sdp); 'terminate' = the call ended. Fase 1a: surface
      // it live in the CRM (SSE) + log the raw shape. The WebRTC answer flow
      // (pre_accept/accept with our SDP answer) comes in 1b.
      if (Array.isArray(value.calls) && value.calls.length > 0) {
        const phoneNumberId = value.metadata?.phone_number_id
        const channel = phoneNumberId
          ? await loadMetaChannelByPhoneNumberId(phoneNumberId)
          : null
        if (!channel) {
          console.error('[webhooks/meta] call event with no matching channel', phoneNumberId)
          continue
        }
        const callerName = value.contacts?.[0]?.profile?.name
        for (const call of value.calls) {
          console.log('[webhooks/meta] CALL event', JSON.stringify({
            id: call.id, from: call.from, event: call.event,
            status: call.status, direction: call.direction,
            sdp_type: call.session?.sdp_type, has_sdp: !!call.session?.sdp,
          }))
          if (call.event === 'terminate') {
            await publishEvent(channel.accountId, {
              type: 'call_status',
              callId: call.id ?? '',
              status: call.status ?? 'COMPLETED',
            })
            // Log the call in the conversation (WhatsApp-style entry).
            try {
              const answered =
                typeof call.duration === 'number' && call.duration > 0
              const normalized = normalizePhone(call.from ?? '')
              const conv = normalized
                ? firstOrNull(
                    await db
                      .select({ id: conversations.id })
                      .from(conversations)
                      .innerJoin(
                        contacts,
                        eq(contacts.id, conversations.contactId),
                      )
                      .where(
                        and(
                          eq(conversations.accountId, channel.accountId),
                          eq(conversations.channelId, channel.id),
                          eq(contacts.phoneNormalized, normalized),
                        ),
                      )
                      .limit(1),
                  )
                : null
              if (conv) {
                const logText = buildCallLog({
                  answered,
                  durationSec: call.duration,
                })
                await db.insert(messages).values({
                  conversationId: conv.id,
                  senderType: 'customer',
                  contentType: 'text',
                  contentText: logText,
                })
                // Direct insert bypasses the inbound pipeline — bump the
                // conversation preview/ordering (floats to the top).
                await db
                  .update(conversations)
                  .set({
                    lastMessageText: logText,
                    lastMessageAt: new Date().toISOString(),
                  })
                  .where(eq(conversations.id, conv.id))
                // Refresh the thread without ringing (fromMe skips the sound).
                await publishEvent(channel.accountId, {
                  type: 'message.received',
                  conversationId: conv.id,
                  fromMe: true,
                })
              }
              // History row for the "Ligações" panel (Meta transport).
              const metaContact = normalized
                ? firstOrNull(
                    await db
                      .select({ id: contacts.id })
                      .from(contacts)
                      .where(
                        and(
                          eq(contacts.accountId, channel.accountId),
                          eq(contacts.phoneNormalized, normalized),
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
                  contactId: metaContact?.id ?? null,
                  peer: call.from ?? '',
                  direction:
                    call.direction === 'BUSINESS_INITIATED' ? 'out' : 'in',
                  status: answered ? 'answered' : 'missed',
                  provider: 'meta',
                  externalCallId: call.id ?? null,
                  durationSec: answered ? (call.duration ?? null) : null,
                })
                .onConflictDoNothing()
            } catch (err) {
              console.error('[webhooks/meta] call-log insert failed:', err)
            }
          } else if (
            call.session?.sdp_type === 'answer' &&
            call.session?.sdp
          ) {
            // The customer answered our OUTBOUND call — deliver their SDP
            // answer to the browser that initiated it.
            await publishEvent(channel.accountId, {
              type: 'call_answer',
              callId: call.id ?? '',
              sdp: call.session.sdp,
            })
          } else {
            // 'connect' with an offer = inbound call ringing — the agent's
            // browser answers it (WebRTC).
            await publishEvent(channel.accountId, {
              type: 'call_incoming',
              callId: call.id ?? '',
              from: call.from ?? '',
              callerName: callerName ?? undefined,
              sdp: call.session?.sdp ?? undefined,
            })
          }
        }
        continue
      }

      // ---- inbound messages ----
      if (!value.messages) continue

      const phoneNumberId = value.metadata?.phone_number_id
      if (!phoneNumberId) {
        console.error('[webhooks/meta] webhook value missing phone_number_id')
        continue
      }

      const channel = await loadMetaChannelByPhoneNumberId(phoneNumberId)
      if (!channel) {
        console.error(
          '[webhooks/meta] No meta channel found for phone_number_id:',
          phoneNumberId,
        )
        continue
      }

      // Reactions are per-(target, actor) state, not messages — the provider
      // parse + pipeline both drop them, so handle them here directly.
      for (const msg of value.messages) {
        if (msg.type === 'reaction' && msg.reaction) {
          await handleMetaReaction(channel, msg)
        }
      }
    }
  }

  // Dispatch inbound (non-reaction) messages through the agnostic pipeline.
  // Done in a separate pass, scoped per-change to the right channel, so
  // media fetch + dispatch use the correct channel and dedup by
  // externalMessageId protects against any overlap.
  await dispatchInboundForBody(body)
}

/**
 * Parse the whole webhook body once and dispatch each NormalizedInbound
 * through the pipeline, resolving the channel per message by its owning
 * change's phone_number_id.
 */
async function dispatchInboundForBody(body: MetaRawBody) {
  // Build a phone_number_id → channel cache so we resolve each channel once.
  const channelCache = new Map<string, ChannelCtx | null>()
  const resolveChannel = async (pnid: string): Promise<ChannelCtx | null> => {
    if (channelCache.has(pnid)) return channelCache.get(pnid) ?? null
    const ch = await loadMetaChannelByPhoneNumberId(pnid)
    channelCache.set(pnid, ch)
    return ch
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field && isTemplateWebhookField(change.field)) continue
      const value = change.value
      if (!value?.messages || !value.metadata?.phone_number_id) continue
      const channel = await resolveChannel(value.metadata.phone_number_id)
      if (!channel) continue

      // Normalize just this change's messages so the media-fetch + dispatch
      // stay scoped to the right channel.
      const parsed = metaProvider.parseWebhook({
        entry: [{ changes: [{ field: change.field, value }] }],
      })

      for (const ev of parsed.messages) {
        // Resolve inbound media bytes when the webhook delivered only an id.
        if (
          ev.media &&
          ev.media.fetchKey &&
          !ev.media.base64 &&
          !ev.media.url &&
          metaProvider.fetchInboundMedia
        ) {
          const fetched = await metaProvider.fetchInboundMedia(
            channel,
            ev.media.fetchKey,
          )
          if (fetched) {
            ev.media.base64 = fetched.base64
            ev.media.mimetype = ev.media.mimetype ?? fetched.mimetype
          }
        }
        try {
          await dispatchInboundMessage(channel, ev)
        } catch (err) {
          console.error('[webhooks/meta] dispatchInboundMessage failed:', err)
        }
      }
    }
  }
}

/**
 * Persist an inbound reaction. Reactions upsert/delete on
 * message_reactions, never into `messages`. Best-effort.
 */
async function handleMetaReaction(channel: ChannelCtx, msg: MetaRawMessage) {
  const reaction = msg.reaction
  if (!reaction?.message_id) return

  // Resolve the target message id (Meta id → internal id) scoped to this
  // account. message_id isn't unique across numbers, so bound to one row.
  const target = firstOrNull(
    await db
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(eq(messages.messageId, reaction.message_id))
      .limit(1),
  )
  if (!target) {
    console.warn('[webhooks/meta] reaction target not found:', reaction.message_id)
    return
  }

  // Resolve the actor contact by phone within this channel's account.
  const { normalizePhone } = await import('@/lib/whatsapp/phone-utils')
  const { findExistingContact } = await import('@/lib/contacts/dedupe')
  const actor = await findExistingContact(
    channel.accountId,
    normalizePhone(msg.from),
  )
  if (!actor) return

  if (!reaction.emoji) {
    try {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, target.id),
            eq(messageReactions.actorType, 'customer'),
            eq(messageReactions.actorId, actor.id),
          ),
        )
    } catch (err) {
      console.error('[webhooks/meta] reaction delete failed:', err)
    }
    return
  }

  try {
    await db
      .insert(messageReactions)
      .values({
        messageId: target.id,
        conversationId: target.conversationId,
        actorType: 'customer',
        actorId: actor.id,
        emoji: reaction.emoji,
      })
      .onConflictDoUpdate({
        target: [
          messageReactions.messageId,
          messageReactions.actorType,
          messageReactions.actorId,
        ],
        set: { emoji: reaction.emoji },
      })
  } catch (err) {
    console.error('[webhooks/meta] reaction upsert failed:', err)
  }
}

// ------------------------------------------------------------
// COEXISTÊNCIA — espelha no CRM as mensagens que o negócio enviou pelo próprio
// WhatsApp (celular/app). O echo chega para TODA mensagem do negócio, inclusive
// as que o CRM mandou pela API — por isso deduplicamos pelo wamid (`message_id`):
// se já existe, foi o CRM que enviou; se não, veio do celular e a gente insere
// como mensagem de saída ('agent') na conversa do cliente.
// ------------------------------------------------------------
async function handleMessageEchoes(value: MetaRawValue) {
  const phoneNumberId = value.metadata?.phone_number_id
  const channel = phoneNumberId
    ? await loadMetaChannelByPhoneNumberId(phoneNumberId)
    : null
  if (!channel) {
    console.error('[webhooks/meta] echo sem canal p/ pnid', phoneNumberId)
    return
  }
  for (const echo of value.message_echoes ?? []) {
    try {
      if (!echo.id || !echo.to) continue
      // Dedupe: já temos esse wamid? (mensagem enviada pelo próprio CRM) → pula.
      const existing = firstOrNull(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.messageId, echo.id))
          .limit(1),
      )
      if (existing) continue

      const digits = String(echo.to).replace(/\D/g, '')
      if (!digits) continue
      const resolved = await resolveConversationByPhone(
        channel.accountId,
        digits,
        null,
        channel.id,
      ).catch(() => null)
      if (!resolved) continue

      const text = echoDisplayText(echo)
      await db.insert(messages).values({
        conversationId: resolved.conversationId,
        senderType: 'agent', // saída: o negócio enviou (pelo celular)
        contentType: 'text',
        contentText: text,
        messageId: echo.id, // wamid — segura o dedupe futuro (status/echo repetido)
        status: 'sent',
        createdAt: echo.timestamp
          ? new Date(Number(echo.timestamp) * 1000).toISOString()
          : new Date().toISOString(),
      })
      await db
        .update(conversations)
        .set({
          lastMessageText: text.slice(0, 500),
          lastMessageAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(conversations.id, resolved.conversationId))
      // fromMe: true → atualiza o thread sem tocar som de notificação.
      await publishEvent(channel.accountId, {
        type: 'message.received',
        conversationId: resolved.conversationId,
        fromMe: true,
      })
    } catch (err) {
      console.error('[webhooks/meta] echo insert failed:', err)
    }
  }
}

/** Texto de exibição de um echo. Texto vira o corpo; mídia vira um rótulo
 *  (+ legenda se houver). V1 não baixa a mídia — o operador sabe o que enviou. */
function echoDisplayText(echo: MetaEchoMessage): string {
  const t = echo.type ?? 'text'
  if (t === 'text') return echo.text?.body ?? ''
  const media = echo[t] as { caption?: string; filename?: string } | undefined
  const label: Record<string, string> = {
    image: '📷 Imagem',
    video: '🎬 Vídeo',
    audio: '🎤 Áudio',
    voice: '🎤 Áudio',
    document: '📄 Documento',
    sticker: 'Figurinha',
    location: '📍 Localização',
    contacts: '👤 Contato',
  }
  const base = label[t] ?? `[${t}]`
  const extra = media?.caption || media?.filename
  return extra ? `${base} — ${extra}` : base
}

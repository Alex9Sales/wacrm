import { NextResponse, after } from 'next/server'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { db, contacts, conversations, messages, memberPresence, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { derivePresence, type StoredPresence } from '@/lib/presence'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { transcribeAudioFromUrl } from '@/lib/ai/transcribe'
import { publishEvent } from '@/lib/events/publish'
import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getUserSectorIds, isAdminUser } from '@/lib/sectors/access'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    // Session + account context. Replaces the old Supabase cookie
    // client — every query below runs on the shared Drizzle client,
    // explicitly scoped by ctx.accountId (no RLS).
    let ctx: AccountContext
    try {
      ctx = await getCurrentAccount()
    } catch (err) {
      return toErrorResponse(err)
    }
    const accountId = ctx.accountId

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = await checkRateLimit(`send:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      // Canal escolhido no "Abrir conversa/Enviar modelo" quando a conta tem
      // 2+ números oficiais — o find-or-create abre a conversa NESSE canal.
      channel_id,
      message_type,
      content_text,
      media_url,
      filename,
      mimetype,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      let conv: { id: string } | null = null
      try {
        conv = firstOrNull(
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, conversationIdInput),
                eq(conversations.accountId, accountId)
              )
            )
            .limit(1)
        )
      } catch {
        // Malformed UUID → Postgres throws where PostgREST returned an
        // error object; both collapse to the same 404.
        conv = null
      }

      if (!conv) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      conversationId = conv.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      let contactRow: { id: string } | null = null
      try {
        contactRow = firstOrNull(
          await db
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(eq(contacts.id, contact_id), eq(contacts.accountId, accountId))
            )
            .limit(1)
        )
      } catch {
        contactRow = null
      }

      if (!contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        accountId,
        ctx.userId,
        contact_id,
        typeof channel_id === 'string' && channel_id ? channel_id : null,
      )
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    // Current assignee — drives both the reply lock and the cover-reassign
    // after a successful send. Fetched once so both use the same value.
    const lockRow = firstOrNull(
      await db
        .select({
          assignedAgentId: conversations.assignedAgentId,
          sectorId: conversations.sectorId,
          isPrivate: conversations.isPrivate,
          isGroup: contacts.isGroup,
        })
        .from(conversations)
        .leftJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(eq(conversations.id, conversationId))
        .limit(1)
    )
    const assignedAgentId = lockRow?.assignedAgentId ?? null
    const currentSectorId = lockRow?.sectorId ?? null
    const conversationIsPrivate = lockRow?.isPrivate === true
    // Grupo é LIVRE: responder num grupo NÃO atribui a ninguém (Felipe).
    const isGroupConversation = lockRow?.isGroup === true
    const assignedToOther = !!assignedAgentId && assignedAgentId !== ctx.userId

    // Is that assignee offline/away right now? If so, any teammate may cover
    // (Alex: "se o atendente tiver offline, outro agente atende") and the
    // thread reassigns to whoever answers, below. Fail-open: a presence
    // lookup hiccup treats the assignee as away so a client isn't left waiting.
    let assigneeAway = false
    if (assignedToOther) {
      try {
        const presenceRow = firstOrNull(
          await db
            .select({
              status: memberPresence.status,
              lastSeenAt: memberPresence.lastSeenAt,
            })
            .from(memberPresence)
            .where(eq(memberPresence.userId, assignedAgentId!))
            .limit(1)
        )
        assigneeAway =
          derivePresence(
            presenceRow?.status as StoredPresence | undefined,
            presenceRow?.lastSeenAt ?? null,
            Date.now()
          ) !== 'online'
      } catch (err) {
        console.error('[send] presence lookup failed, allowing cover:', err)
        assigneeAway = true
      }
    }

    // Reply lock (sector model — Felipe's spec). Once assigned, a thread is
    // normally the owner's to answer. EXCEPTION: inside a sector the caller
    // belongs to, teammates reply freely to each other's threads — assignment
    // just marks "who picked it up first" and answering never steals it (the
    // claim below only fires on an UNASSIGNED thread). The private lock and
    // admin-owned threads stay locked; a NO-sector assigned thread also stays
    // the owner's (only they + supervisor+, or a teammate covering when away).
    let sectorTeammateMayReply = false
    if (
      assignedToOther &&
      !assigneeAway &&
      !hasMinRole(ctx.role, 'supervisor') &&
      currentSectorId &&
      !conversationIsPrivate
    ) {
      const callerSectorIds = await getUserSectorIds(ctx.userId)
      if (callerSectorIds.includes(currentSectorId)) {
        // Never open an admin/owner's thread to a regular agent.
        sectorTeammateMayReply = !(await isAdminUser(
          ctx.accountId,
          assignedAgentId!,
        ))
      }
    }
    if (
      !hasMinRole(ctx.role, 'supervisor') &&
      assignedToOther &&
      !assigneeAway &&
      !sectorTeammateMayReply
    ) {
      return NextResponse.json(
        {
          error: 'Esta conversa está atribuída a outro atendente.',
          code: 'conversation_locked',
        },
        { status: 403 }
      )
    }

    // Agent signature (workspace toggle): prefix the human agent's name in
    // bold so the customer sees who replied. Applies only to this dashboard
    // route (real people) — NOT the v1 API (agents) or automations/AI, which
    // never hit this path. Skips templates and empty bodies (bare media).
    let outboundText: string | null | undefined = content_text
    if (
      typeof content_text === 'string' &&
      content_text.trim() &&
      message_type !== 'template'
    ) {
      // Fail-open: a settings/user lookup hiccup must never block the send —
      // worst case the message just goes out without the signature.
      try {
        const settings = await getAccountSettings(accountId)
        if (settings.agentSignatureEnabled) {
          const sender = firstOrNull(
            await db
              .select({ name: user.name })
              .from(user)
              .where(eq(user.id, ctx.userId))
              .limit(1),
          )
          const name = sender?.name?.trim()
          if (name) outboundText = `*${name}:*\n${content_text}`
        }
      } catch (err) {
        console.error('[send] signature lookup failed, sending without it:', err)
      }
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      // 👤 Humano respondeu pelo CRM → novo episódio: zera o limite de respostas
      // automáticas da IA nesta conversa (best-effort; Rafael 01/09).
      try {
        await db
          .update(conversations)
          .set({ aiReplyCount: 0 })
          .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
      } catch (err) {
        console.error('[send] reset do limite da IA falhou:', err)
      }
      const result = await sendMessageToConversation(accountId, {
        conversationId,
        messageType: message_type,
        contentText: outboundText,
        mediaUrl: media_url,
        filename,
        mimetype,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        replyToMessageId: reply_to_message_id,
      })

      // Transcribe an agent voice note recorded in the CRM (Alex asked for
      // sent audio too). This path can't be caught by the inbound transcriber:
      // the send persists the row and the gows echo is deduplicated, so it
      // never reaches inbound. Done AFTER the response so the send stays fast;
      // best-effort, opt-in. (Audio sent from the operator's phone is handled
      // by the inbound transcriber instead.)
      if (message_type === 'audio' && media_url && result?.messageId) {
        const msgId = result.messageId
        const convId = conversationId
        after(async () => {
          try {
            const { audioTranscriptionEnabled } =
              await getAccountSettings(accountId)
            if (!audioTranscriptionEnabled) return
            const text = await transcribeAudioFromUrl(accountId, media_url)
            if (!text) return
            await db
              .update(messages)
              .set({ transcription: text })
              .where(eq(messages.id, msgId))
            if (convId)
              await publishEvent(accountId, {
                type: 'message.received',
                conversationId: convId,
                fromMe: true,
              })
          } catch (err) {
            console.error('[send] agent audio transcription failed:', err)
          }
        })
      }

      // Claim / cover on reply. Two cases, both best-effort (a hiccup must
      // never fail the send that already went out) and both suppress the
      // assignment-notification trigger:
      //   • Claim: a human answering an UNASSIGNED thread takes ownership
      //     (isNull guard → never clobbers an existing assignee).
      //   • Cover: a non-supervisor answering a thread whose assignee is
      //     offline/away takes it over — "ao responder, reatribui pra quem
      //     respondeu". Guarded on the assignee still being that agent so two
      //     concurrent covers don't fight. Supervisors keep the old behavior
      //     (help without stealing).
      // A sector teammate answering a colleague's thread must NEVER steal it
      // (Felipe's spec) — even if the owner is away, it stays the owner's until
      // an explicit transfer. Cover-reassign only applies OUTSIDE the shared
      // sector (e.g. a no-sector queue thread being covered for an away owner).
      const coverReassign =
        assignedToOther &&
        assigneeAway &&
        !hasMinRole(ctx.role, 'supervisor') &&
        !sectorTeammateMayReply
      // Grupo NUNCA é atribuído (livre pra toda a equipe) — pula claim/cover.
      if (!isGroupConversation) {
        try {
          await db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL app.suppress_assign_notify = 'on'`)
            await tx
              .update(conversations)
              .set({
                assignedAgentId: ctx.userId,
                assignedAt: new Date().toISOString(),
              })
              .where(
                and(
                  eq(conversations.id, conversationId!),
                  eq(conversations.accountId, accountId),
                  coverReassign
                    ? eq(conversations.assignedAgentId, assignedAgentId!)
                    : isNull(conversations.assignedAgentId),
                ),
              )
          })
        } catch (err) {
          console.error('[send] claim/cover-on-reply failed:', err)
        }

        // Setor no reply (Alex: "responder atribui a ele e ao setor dele"): se a
        // conversa está SEM setor, cai no setor do agente que respondeu. Cobre
        // tanto o claim (recém-atribuída) quanto a conversa que já é dele mas
        // ficou sem setor (ex.: canal sem setor default). Guard isNull(sector)
        // → nunca sobrescreve um setor existente. Grupos ficam de fora (bloco).
        if (!currentSectorId) {
          try {
            const agentSectors = await getUserSectorIds(ctx.userId)
            const agentSectorId = agentSectors[0]
            if (agentSectorId) {
              await db
                .update(conversations)
                .set({ sectorId: agentSectorId })
                .where(
                  and(
                    eq(conversations.id, conversationId!),
                    eq(conversations.accountId, accountId),
                    isNull(conversations.sectorId),
                  ),
                )
            }
          } catch (err) {
            console.error('[send] sector-on-reply failed:', err)
          }
        }
      }

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        // Log it. The client gets a toast, but until now these failures were
        // invisible in the server logs — which made intermittent media/voice
        // send failures impossible to diagnose. Include enough to trace it.
        console.error(
          `[send] SendMessageError conv=${conversationId} type=${message_type} media=${media_url ? 'yes' : 'no'} status=${err.status}: ${err.message}`,
        )
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Account-scoped explicitly — there is no RLS on the
 * shared Drizzle client.
 */
async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
  channelId?: string | null,
): Promise<string | null> {
  // Com channel escolhido (conta com 2+ números oficiais), a conversa é
  // procurada/criada NAQUELE canal — senão pega qualquer uma do contato.
  const existing = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.contactId, contactId),
          channelId ? eq(conversations.channelId, channelId) : undefined,
        )
      )
      .limit(1)
  )

  if (existing) return existing.id

  try {
    const created = firstOrNull(
      await db
        .insert(conversations)
        .values({
          accountId,
          userId,
          contactId,
          ...(channelId ? { channelId } : {}),
        })
        .returning({ id: conversations.id })
    )
    return created?.id ?? null
  } catch (error) {
    console.error(
      'Error creating conversation for contact send:',
      error instanceof Error ? error.message : error
    )
    return null
  }
}

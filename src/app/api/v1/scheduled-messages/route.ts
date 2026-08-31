// ============================================================
// /api/v1/scheduled-messages — agendar mensagem pro FUTURO ("manda amanhã
// às 9h"). O worker de agendadas envia na hora marcada pelo canal da
// conversa; aparece na Central de Agendamentos do CRM.
//
// GET  ?status=pending&limit=  — lista (scope messages:read)
// POST { conversation_id | (contact_id + channel_id), text, scheduled_at }
//      (scope messages:send). scheduled_at em ISO-8601 (com timezone!).
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { db, conversations, scheduledMessages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:read')
    const url = new URL(request.url)
    const status = url.searchParams.get('status') ?? 'pending'
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit')) || 50, 1),
      200,
    )
    const rows = await db
      .select({
        id: scheduledMessages.id,
        conversation_id: scheduledMessages.conversationId,
        contact_id: scheduledMessages.contactId,
        text: scheduledMessages.contentText,
        scheduled_at: scheduledMessages.scheduledAt,
        status: scheduledMessages.status,
      })
      .from(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.accountId, ctx.accountId),
          eq(scheduledMessages.status, status),
        ),
      )
      .orderBy(desc(scheduledMessages.scheduledAt))
      .limit(limit)
    return ok({ scheduled_messages: rows })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send')
    let body: {
      conversation_id?: unknown
      contact_id?: unknown
      channel_id?: unknown
      text?: unknown
      scheduled_at?: unknown
    }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw badRequest("'text' is required")
    const when =
      typeof body.scheduled_at === 'string' ? new Date(body.scheduled_at) : null
    if (!when || Number.isNaN(when.getTime()))
      throw badRequest("'scheduled_at' must be an ISO-8601 datetime")
    if (when.getTime() < Date.now() + 30_000)
      throw badRequest("'scheduled_at' must be in the future")

    const auditUserId = await resolveAuditUserId(ctx.accountId)

    // Resolve a conversa: direta, ou abre pela dupla contato+canal.
    let conversationId =
      typeof body.conversation_id === 'string' && body.conversation_id
        ? body.conversation_id
        : null
    let contactId: string | null =
      typeof body.contact_id === 'string' && body.contact_id
        ? body.contact_id
        : null
    if (conversationId) {
      const conv = firstOrNull(
        await db
          .select({
            id: conversations.id,
            contactId: conversations.contactId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      )
      if (!conv) return fail('not_found', 'Conversation not found', 404)
      contactId = conv.contactId
    } else {
      const channelId =
        typeof body.channel_id === 'string' && body.channel_id
          ? body.channel_id
          : null
      if (!contactId || !channelId)
        throw badRequest(
          "Provide 'conversation_id' OR ('contact_id' + 'channel_id')",
        )
      const { findOrCreateConversation } = await import(
        '@/lib/channels/inbound'
      )
      const result = await findOrCreateConversation(
        ctx.accountId,
        auditUserId,
        contactId,
        channelId,
      )
      if (!result?.conversation)
        return fail('internal', 'Could not open a conversation', 500)
      conversationId = result.conversation.id
    }

    const created = firstOrNull(
      await db
        .insert(scheduledMessages)
        .values({
          accountId: ctx.accountId,
          conversationId,
          contactId,
          messageType: 'text',
          contentText: text,
          scheduledAt: when.toISOString(),
          status: 'pending',
          createdBy: auditUserId,
        })
        .returning({ id: scheduledMessages.id }),
    )
    if (!created) return fail('internal', 'Failed to schedule', 500)
    return ok(
      {
        id: created.id,
        conversation_id: conversationId,
        scheduled_at: when.toISOString(),
      },
      201,
    )
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

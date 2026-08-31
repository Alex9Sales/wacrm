// ============================================================
// POST /api/v1/reactivation/send — envia a mensagem de reativação e RESOLVE
// o sinal (o cliente sai da lista "chamar de volta"). Contato importado sem
// conversa: informe channel_id e a conversa é criada na linha escolhida.
//
// ⚠️ ENVIA MENSAGEM REAL ao cliente — respeita opt-out automaticamente.
// Body: { contact_id, signal_type, text, channel_id? }
// Scope: messages:send
// ============================================================

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { db, contacts, conversations, customerSignals } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send')

    let body: {
      contact_id?: unknown
      signal_type?: unknown
      text?: unknown
      channel_id?: unknown
    }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const contactId =
      typeof body.contact_id === 'string' ? body.contact_id : ''
    const signalType =
      typeof body.signal_type === 'string' ? body.signal_type : ''
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const channelId =
      typeof body.channel_id === 'string' && body.channel_id
        ? body.channel_id
        : null
    if (!contactId) throw badRequest("'contact_id' is required")
    if (!signalType) throw badRequest("'signal_type' is required")
    if (!text) throw badRequest("'text' is required")

    const contact = firstOrNull(
      await db
        .select({ id: contacts.id, optedOut: contacts.optedOut })
        .from(contacts)
        .where(
          and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)),
        )
        .limit(1),
    )
    if (!contact) return fail('not_found', 'Contact not found', 404)
    if (contact.optedOut)
      return fail('forbidden', 'Contact opted out (não perturbe)', 403)

    const auditUserId = await resolveAuditUserId(ctx.accountId)

    // Conversa existente mais recente, ou cria na linha informada.
    let conversationId =
      firstOrNull(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.accountId, ctx.accountId),
              eq(conversations.contactId, contactId),
            ),
          )
          .orderBy(desc(conversations.createdAt))
          .limit(1),
      )?.id ?? null
    if (!conversationId) {
      if (!channelId)
        throw badRequest(
          "Contact has no conversation — provide 'channel_id' to open one",
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

    const { engineSendText } = await import('@/lib/flows/meta-send')
    await engineSendText({
      accountId: ctx.accountId,
      userId: auditUserId,
      conversationId,
      contactId,
      text,
    })

    // Resolve o sinal — sai da lista "chamar de volta".
    await db
      .update(customerSignals)
      .set({ resolvedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          eq(customerSignals.accountId, ctx.accountId),
          eq(customerSignals.contactId, contactId),
          eq(customerSignals.signalType, signalType),
          isNull(customerSignals.resolvedAt),
        ),
      )

    return ok({ sent: true, conversation_id: conversationId })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

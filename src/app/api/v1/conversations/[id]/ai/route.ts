// ============================================================
// POST /api/v1/conversations/:id/ai — liga/desliga a IA NESTA conversa.
//
// Pro agente externo assumir ("desliga a IA que eu cuido") ou devolver o
// atendimento pra IA da conta. Ao LIGAR com mensagem do cliente parada, a
// IA responde na hora (catch-up) — não espera o cliente escrever de novo.
//
// Body: { enabled: boolean }
// Scope: conversations:write
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { db, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { publishEvent } from '@/lib/events/publish'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write')
    const { id: conversationId } = await params

    let body: { enabled?: unknown }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    if (typeof body.enabled !== 'boolean')
      throw badRequest("'enabled' must be true or false")
    const enabled = body.enabled

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

    await db
      .update(conversations)
      .set({
        aiAutoreplyDisabled: !enabled,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conversationId))

    // Ligou com msg do cliente parada → responde na hora (mesma mecânica do
    // toggle da UI; o guard anti-eco garante zero resposta dupla).
    if (enabled && conv.contactId) {
      try {
        const last = firstOrNull(
          await db
            .select({
              senderType: messages.senderType,
              isInternal: messages.isInternal,
            })
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            .orderBy(desc(messages.createdAt))
            .limit(1),
        )
        if (last && last.senderType === 'customer' && !last.isInternal) {
          const auditUserId = await resolveAuditUserId(ctx.accountId)
          const { enqueueAiReplyDebounced } = await import('@/lib/queue/queues')
          await enqueueAiReplyDebounced(
            {
              accountId: ctx.accountId,
              conversationId,
              contactId: conv.contactId,
              configOwnerUserId: auditUserId,
            },
            0,
          )
        }
      } catch (err) {
        console.error('[v1 ai-toggle] catch-up failed:', err)
      }
    }

    // Hidrata a linha da conversa na UI (mesmo caminho do inbound fromMe).
    await publishEvent(ctx.accountId, {
      type: 'message.received',
      conversationId,
      fromMe: true,
    })
    return ok({ id: conversationId, ai_enabled: enabled })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

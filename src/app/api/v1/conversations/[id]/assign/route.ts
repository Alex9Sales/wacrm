// ============================================================
// POST /api/v1/conversations/:id/assign — atribui/desatribui a conversa.
//
// Pro agente externo escalar um atendimento pra um humano específico
// ("assume esse cliente") ou devolver pra fila/IA (member_id: null).
// Notifica o membro atribuído (sino + deep-link). Ao DESATRIBUIR com a IA
// ligada e a última mensagem sendo do cliente, dispara o catch-up — a IA
// responde na hora em vez de esperar o cliente escrever de novo.
//
// Body: { member_id: string | null }
// Scope: conversations:write
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, conversations, notifications, member } from '@/db'
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

    let body: { member_id?: unknown }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const memberId =
      body.member_id === null
        ? null
        : typeof body.member_id === 'string' && body.member_id
          ? body.member_id
          : undefined
    if (memberId === undefined)
      throw badRequest("'member_id' must be a member user id or null")

    const conv = firstOrNull(
      await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          aiOff: conversations.aiAutoreplyDisabled,
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

    if (memberId) {
      const m = firstOrNull(
        await db
          .select({ userId: member.userId })
          .from(member)
          .where(
            and(
              eq(member.organizationId, ctx.accountId),
              eq(member.userId, memberId),
            ),
          )
          .limit(1),
      )
      if (!m) return fail('not_found', 'Member not found in this account', 404)
    }

    await db
      .update(conversations)
      .set({ assignedAgentId: memberId, updatedAt: new Date().toISOString() })
      .where(eq(conversations.id, conversationId))

    const auditUserId = await resolveAuditUserId(ctx.accountId)
    if (memberId) {
      try {
        await db.insert(notifications).values({
          accountId: ctx.accountId,
          userId: memberId,
          type: 'conversation_assigned',
          conversationId,
          actorUserId: auditUserId,
          title: '🤖 Conversa atribuída a você (via agente)',
          body: 'Um agente externo passou este atendimento pra você.',
        })
      } catch (err) {
        console.error('[v1 assign] notify failed:', err)
      }
    } else if (!conv.aiOff && conv.contactId) {
      // Desatribuiu com IA ligada → catch-up: responde já a última msg do
      // cliente, se houver (o guard anti-eco do dispatch cobre o resto).
      try {
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
      } catch (err) {
        console.error('[v1 assign] ai catch-up failed:', err)
      }
    }

    // Hidrata a linha da conversa na UI (mesmo caminho do inbound fromMe).
    await publishEvent(ctx.accountId, {
      type: 'message.received',
      conversationId,
      fromMe: true,
    })
    return ok({ id: conversationId, assigned_member_id: memberId })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

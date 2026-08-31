// ============================================================
// POST /api/v1/conversations/:id/notes — NOTA INTERNA via API pública.
//
// Pedido do Felipe (31/08): o agente autônomo dele (Hermes) precisava
// MENCIONAR um atendente numa conversa ("fulano, esse cliente está sem
// resposta") e não havia rota. A nota fica no thread (is_internal=true),
// NUNCA vai pro cliente, e cada membro mencionado recebe a notificação
// com deep-link pra conversa (mesma mecânica do @ do composer).
//
// Body: { text: string, mention_member_ids?: string[] }
//   - menções também funcionam por @Nome dentro do texto (parseMentions);
//   - mention_member_ids aceita ids de usuário (rota GET /v1/members) pra o
//     agente não depender de acertar a grafia do nome.
// Scope: conversations:write
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import {
  db,
  conversations,
  messages,
  notifications,
  member,
  user,
  conversationParticipants,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { publishEvent } from '@/lib/events/publish'
import { parseMentions } from '@/lib/inbox/mentions'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write')
    const { id: conversationId } = await params

    let body: { text?: unknown; mention_member_ids?: unknown }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw badRequest("'text' is required")
    if (text.length > 4000) throw badRequest("'text' too long (max 4000)")
    const explicitIds = Array.isArray(body.mention_member_ids)
      ? body.mention_member_ids.filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : []

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id })
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

    const auditUserId = await resolveAuditUserId(ctx.accountId)

    // Nota no thread — NUNCA vai pro cliente (sem chamada de provider).
    const inserted = firstOrNull(
      await db
        .insert(messages)
        .values({
          conversationId,
          senderType: 'agent',
          senderId: auditUserId,
          contentType: 'text',
          contentText: text,
          isInternal: true,
          status: 'sent',
        })
        .returning({ id: messages.id }),
    )

    // Menções: @Nome no texto + ids explícitos (validados como membros da conta).
    let mentionedIds: string[] = []
    try {
      const members = await db
        .select({ id: user.id, name: user.name })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(eq(member.organizationId, ctx.accountId))
      const validIds = new Set(members.map((m) => m.id))
      mentionedIds = [
        ...new Set([
          ...parseMentions(text, members),
          ...explicitIds.filter((id) => validIds.has(id)),
        ]),
      ]
      if (mentionedIds.length > 0) {
        // Acesso à conversa pros mencionados (senão a menção é um link morto).
        await db
          .insert(conversationParticipants)
          .values(
            mentionedIds.map((uid) => ({ conversationId, userId: uid })),
          )
          .onConflictDoNothing()
        await db.insert(notifications).values(
          mentionedIds.map((uid) => ({
            accountId: ctx.accountId,
            userId: uid,
            type: 'mention' as const,
            conversationId,
            actorUserId: auditUserId,
            title: '🤖 Agente (via API) mencionou você',
            body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
          })),
        )
        await publishEvent(ctx.accountId, {
          type: 'mention',
          conversationId,
          senderName: 'Agente (API)',
          mentionedUserIds: mentionedIds,
        })
      }
    } catch (err) {
      console.error('[v1 notes] mention notify failed:', err)
    }

    // Atualiza o thread aberto (fromMe pula o som de notificação).
    await publishEvent(ctx.accountId, {
      type: 'message.received',
      conversationId,
      fromMe: true,
    })

    return ok(
      {
        id: inserted?.id ?? null,
        internal: true,
        mentioned_member_ids: mentionedIds,
      },
      201,
    )
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

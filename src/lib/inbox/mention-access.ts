// ============================================================
// Acesso por @menção numa conversa (conversation_participants.source).
//
// Origens (migr 0175):
//   • 'mention'             — @menção: lê a conversa por cima de dono, setor,
//                             canal dedicado e privacidade. Vale até a pessoa
//                             responder com uma nota (acesso de uma vez só).
//   • 'broadcast'           — criou o disparo que abriu a conversa
//                             (lib/broadcasts/conversation-link). Permanente,
//                             mas cai sozinho quando a conversa vira privada ou
//                             alguém a pega (lib/sectors/access.ts).
//   • 'broadcast_mentioned' — quem já acompanhava por disparo e foi mencionado:
//                             lê como menção; ao responder volta a 'broadcast'
//                             (não perde o acompanhamento do próprio disparo).
// ============================================================

import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, conversationParticipants } from '@/db'

/** Dá acesso de menção (sem rebaixar quem já estava por disparo). */
export async function grantMentionAccess(
  conversationId: string,
  userIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (!conversationId || ids.length === 0) return
  await db
    .insert(conversationParticipants)
    .values(ids.map((userId) => ({ conversationId, userId, source: 'mention' })))
    .onConflictDoUpdate({
      target: [conversationParticipants.conversationId, conversationParticipants.userId],
      set: {
        source: sql`CASE WHEN "conversation_participants"."source" IN ('broadcast', 'broadcast_mentioned') THEN 'broadcast_mentioned' ELSE 'mention' END`,
      },
    })
}

/**
 * A pessoa respondeu (escreveu nota): acaba o acesso de menção. Quem estava
 * por disparo volta a só acompanhar o disparo; 'broadcast' não muda.
 */
export async function endMentionAccess(conversationId: string, userId: string): Promise<void> {
  if (!conversationId || !userId) return
  const mine = and(
    eq(conversationParticipants.conversationId, conversationId),
    eq(conversationParticipants.userId, userId),
  )
  await db.delete(conversationParticipants).where(and(mine, eq(conversationParticipants.source, 'mention')))
  await db
    .update(conversationParticipants)
    .set({ source: 'broadcast' })
    .where(and(mine, inArray(conversationParticipants.source, ['broadcast_mentioned'])))
}

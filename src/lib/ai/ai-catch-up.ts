// ============================================================
// Ao LIGAR a IA (ou tirar o responsável), retoma a mensagem do cliente parada.
//
// Se a última mensagem da conversa é do CLIENTE (sem resposta), enfileira a
// resposta pelo MESMO caminho do inbound (debounced). Se a última for do bot
// (já respondeu) ou do atendente (humano assumiu), não faz nada — e o dispatch
// ainda revalida todos os gates (atribuição, teto, barge-in, etc.).
//
// Revisão 15/09 (GoLink): "Tirar responsável" nunca retomava. Ligar a IA grava
// a nota interna "▶️ IA religada…" e a busca da última mensagem pegava ESSA
// nota (sender 'bot', is_internal = true) — desistia sempre. Nota interna
// não é conversa com o cliente: fica fora da busca.
//
// Best-effort: nunca lança (não pode quebrar o toggle nem a desatribuição).
// ============================================================

import { and, desc, eq, sql } from 'drizzle-orm'

import { db, contacts, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'

export async function aiCatchUpOnEnable(
  accountId: string,
  conversationId: string,
): Promise<void> {
  try {
    const last = firstOrNull(
      await db
        .select({ senderType: messages.senderType })
        .from(messages)
        .where(and(eq(messages.conversationId, conversationId), eq(messages.isInternal, false)))
        // ⚠️ DESC põe NULL primeiro: NULLS LAST + id de desempate (mesmo índice
        // idx_messages_conversation_created).
        .orderBy(sql`${messages.createdAt} DESC NULLS LAST`, desc(messages.id))
        .limit(1),
    )
    if (!last || last.senderType !== 'customer') return

    const conv = firstOrNull(
      await db
        .select({ contactId: conversations.contactId })
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.accountId, accountId)))
        .limit(1),
    )
    if (!conv?.contactId) return
    const contact = firstOrNull(
      await db
        .select({ userId: contacts.userId })
        .from(contacts)
        .where(eq(contacts.id, conv.contactId))
        .limit(1),
    )
    const { enqueueAiReplyDebounced } = await import('@/lib/queue/queues')
    await enqueueAiReplyDebounced(
      {
        accountId,
        conversationId,
        contactId: conv.contactId,
        configOwnerUserId: contact?.userId ?? '',
      },
      0,
    )
  } catch (err) {
    console.error('[ai catch-up on enable] falhou:', err)
  }
}

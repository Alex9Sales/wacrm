// ============================================================
// 📬 "Já chegou?" — a cópia entregue de uma cobrança que o canal disse ter falhado.
//
// 14/09 (régua): o WAHA devolveu erro mas ENTREGOU; o sender tentou de novo e
// o devedor recebeu a mesma cobrança duas vezes. Antes de reenviar, procura a
// mensagem na conversa de WhatsApp do contato a partir do instante do pedido.
// Usado pelo sender (worker) e pelo envio à mão da carteira (22/09).
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, asc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'

import { db, channels, conversations, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'

import { deliveredEchoSnippet } from './rules'

/**
 * Mensagem nossa (agente/robô), em conversa de WhatsApp do contato, criada a
 * partir de `createdAt` e que contém o começo do rascunho. `null` = não achou
 * (ou o rascunho é curto demais para reconhecer).
 */
export async function findDeliveredWhatsAppCopy(
  accountId: string,
  row: { contactId: string; createdAt: string; suggestedText: string | null },
): Promise<{ id: string; conversationId: string; createdAt: string | null } | null> {
  const snippet = deliveredEchoSnippet(row.suggestedText)
  if (!snippet) return null
  return firstOrNull(
    await db
      .select({ id: messages.id, conversationId: messages.conversationId, createdAt: messages.createdAt })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .innerJoin(channels, eq(channels.id, conversations.channelId))
      .where(
        and(
          eq(conversations.accountId, accountId),
          eq(conversations.contactId, row.contactId),
          notInArray(channels.provider, ['email', 'gmail']),
          inArray(messages.senderType, ['agent', 'bot']),
          eq(messages.isInternal, false),
          gte(messages.createdAt, row.createdAt),
          sql`position(${snippet} in regexp_replace(${messages.contentText}, ${'\\s+'}, ' ', 'g')) > 0`,
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1),
  )
}

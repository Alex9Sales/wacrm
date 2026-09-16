// ============================================================
// O link de pagamento já chegou ao cliente? — usado pelo lembrete e pelo
// aviso de cobrança nova (16/09: aviso que "falhou" na 3ª tentativa mas
// entregou não pode mandar o link de novo quando volta para a fila).
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, gte, inArray, ne, or, sql } from 'drizzle-orm'

import { db, conversations, messages } from '@/db'

import { textHasUrl } from './rules'

/**
 * Quais destes links (invoiceUrl) já saíram numa mensagem PARA o cliente desde
 * `sinceIso`: mensagem não interna, escrita pelo time ou pelo CRM (agent/bot),
 * em qualquer conversa do contato. É a prova de que o link chegou — a criação
 * com "mandar o link", o [[COBRAR:]] da IA ou alguém colando à mão. Se o envio
 * falhou ou o link foi desmarcado, não há mensagem e o lembrete sai.
 */
export async function linksAlreadySent(accountId: string, contactId: string, urls: string[], sinceIso: string): Promise<Set<string>> {
  const found = new Set<string>()
  if (!urls.length) return found
  const rows = await db
    .select({ text: messages.contentText })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
        eq(messages.isInternal, false),
        inArray(messages.senderType, ['agent', 'bot']),
        // Envio que falhou (e-mail devolvido, falha da Meta) não prova que o
        // link chegou — o lembrete tem de sair (revisão 15/09).
        ne(messages.status, 'failed'),
        gte(messages.createdAt, sinceIso),
        or(...urls.map((u) => sql`position(${u} in ${messages.contentText}) > 0`)),
      ),
    )
    .limit(50)
  // O banco acha "contém"; aqui confirma que é o link inteiro (…/i/123 ≠ …/i/1234).
  for (const r of rows) for (const u of urls) if (textHasUrl(r.text, u)) found.add(u)
  return found
}

// ============================================================
// Fase B — Transferência inteligente pra humano (por etiqueta no atendente).
// Worker-safe. A IA escolhe uma etiqueta de roteamento (ex.: "Gerente"); nós
// achamos o atendente com essa etiqueta, ATRIBUÍMOS a conversa a ele, postamos
// o RESUMO como nota interna, DESLIGAMOS a IA na conversa e notificamos.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'
import {
  db,
  member,
  memberTags,
  tags,
  conversations,
  contacts,
  notifications,
  messages,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { alertContactName, oneLineSummary } from '@/lib/alerts/alert-text'

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Atendentes da etiqueta que a IA escreveu. Pura. Ordem:
 *   1. nome exato;
 *   2. etiqueta que aparece como PALAVRA INTEIRA no que a IA escreveu
 *      ("Responsável - Gás do Povo" → "Responsável"), ficando só a MAIS LONGA
 *      ("Gerente Financeiro" vence "Gerente"; "TI" não casa dentro de "Garantia");
 *   3. o que a IA escreveu é pedaço de UMA única etiqueta ("Financeiro" →
 *      "Gerente Financeiro").
 * `want` e `tagName` já normalizados (sem acento, minúsculo).
 */
export function matchRoutingTag<T extends { tagName: string }>(candidates: T[], want: string): T[] {
  if (!want) return []
  const n = (c: T) => norm(c.tagName)
  const exact = candidates.filter((c) => n(c) === want)
  if (exact.length) return exact
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const whole = candidates.filter((c) => {
    const t = n(c)
    return !!t && new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`).test(want)
  })
  if (whole.length) {
    const longest = Math.max(...whole.map((c) => n(c).length))
    return whole.filter((c) => n(c).length === longest)
  }
  const partOf = candidates.filter((c) => n(c).includes(want))
  return new Set(partOf.map(n)).size === 1 ? partOf : []
}

/** Etiquetas que estão em pelo menos UM atendente (opções de roteamento). */
export async function listRoutingTags(accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: tags.name })
    .from(memberTags)
    .innerJoin(tags, eq(tags.id, memberTags.tagId))
    .innerJoin(member, eq(member.id, memberTags.memberId))
    .where(
      and(eq(tags.accountId, accountId), eq(member.organizationId, accountId)),
    )
  return rows.map((r) => r.name).filter(Boolean)
}

export interface TransferResult {
  assignedUserId: string | null
  tag: string
}

/**
 * Transfere a conversa pro atendente com a etiqueta `tagName`. Best-effort.
 * Escolhe o atendente MENOS carregado (menos conversas abertas atribuídas).
 */
export async function applyTransfer(input: {
  accountId: string
  conversationId: string
  contactId: string | null
  tagName: string
  summary: string | null
}): Promise<TransferResult> {
  const { accountId, conversationId, contactId, tagName, summary } = input
  const result: TransferResult = { assignedUserId: null, tag: tagName }

  // 📣 Aviso no WhatsApp do responsável (se configurado): a IA escalou — o
  // gestor fica sabendo NA HORA, com o resumo, mesmo sem abrir o CRM. Roda
  // antes do rodízio de propósito: sem atendente com a etiqueta, o aviso é
  // ainda mais importante. Best-effort.
  try {
    const contact = contactId
      ? firstOrNull(
          await db
            .select({ name: contacts.name, phone: contacts.phone })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1),
        )
      : null
    const { sendOwnerAlert } = await import('@/lib/alerts/owner-alerts')
    await sendOwnerAlert(accountId, 'handoff', {
      cliente: contact?.name ?? '',
      telefone: contact?.phone ?? '',
      motivo: tagName,
      // O resumo vem do modelo e pode ter quebra de linha/link: uma linha só.
      resumo: oneLineSummary(summary),
    })
  } catch (err) {
    console.error('[ai transfer] aviso ao responsável falhou:', err)
  }

  try {
    // Atendentes com essa etiqueta (casa por nome normalizado).
    const candidates = await db
      .select({ userId: member.userId, tagName: tags.name })
      .from(memberTags)
      .innerJoin(member, eq(member.id, memberTags.memberId))
      .innerJoin(tags, eq(tags.id, memberTags.tagId))
      .where(
        and(eq(tags.accountId, accountId), eq(member.organizationId, accountId)),
      )
    const want = norm(tagName)
    const matched = matchRoutingTag(candidates, want)
    if (matched.length === 0) {
      // Ninguém com a etiqueta: a IA já disse ao cliente que um humano vai
      // continuar — então ela PARA, a conversa fica pendente e o resumo fica
      // na tela (antes seguia respondendo como se nada tivesse acontecido).
      try {
        const note = (summary || '').trim()
        await db.insert(messages).values({
          conversationId,
          senderType: 'bot',
          contentType: 'text',
          contentText: `🔁 *Transferido pela IA* — ${tagName} (nenhum atendente com essa etiqueta)${note ? `\n${note}` : ''}`,
          isInternal: true,
          status: 'sent',
        })
        await db
          .update(conversations)
          .set({ aiAutoreplyDisabled: true, status: 'pending', updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, conversationId))
      } catch (err) {
        console.error('[ai transfer] sem atendente com a etiqueta — pausar a IA falhou:', err)
      }
      return result
    }

    // Menos carregado: menos conversas abertas atribuídas a ele.
    let chosen = matched[0].userId
    if (matched.length > 1) {
      let best = Number.POSITIVE_INFINITY
      for (const c of matched) {
        const [row] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(conversations)
          .where(
            and(
              eq(conversations.accountId, accountId),
              eq(conversations.assignedAgentId, c.userId),
              sql`${conversations.status} <> 'closed'`,
            ),
          )
        const n = Number(row?.n ?? 0)
        if (n < best) {
          best = n
          chosen = c.userId
        }
      }
    }

    // 1) Nota interna com o resumo (só pra equipe).
    const note = (summary || '').trim()
    if (note) {
      try {
        await db.insert(messages).values({
          conversationId,
          senderType: 'bot',
          contentType: 'text',
          contentText: `🔁 *Transferido pela IA* — ${tagName}\n${note}`,
          isInternal: true,
          status: 'sent',
        })
      } catch (err) {
        console.error('[ai transfer] nota interna falhou:', err)
      }
    }

    // 2) Atribui + IA off + pending. O trigger notify_conversation_assigned
    //    dispara quando o assignee MUDA; senão notificamos no passo 3.
    const current = firstOrNull(
      await db
        .select({ assignedAgentId: conversations.assignedAgentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1),
    )
    const willNotify = current?.assignedAgentId !== chosen
    await db
      .update(conversations)
      .set({
        assignedAgentId: chosen,
        aiAutoreplyDisabled: true,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conversationId))
    result.assignedUserId = chosen

    // 3) Notifica explicitamente se o trigger não vai (assignee não mudou).
    if (!willNotify && contactId) {
      try {
        const contact = firstOrNull(
          await db
            .select({ name: contacts.name, phone: contacts.phone })
            .from(contacts)
            .where(eq(contacts.id, contactId))
            .limit(1),
        )
        const who = alertContactName(contact?.name, contact?.phone) || contact?.phone || 'um contato'
        await db.insert(notifications).values({
          accountId,
          userId: chosen,
          type: 'conversation_assigned',
          conversationId,
          contactId,
          title: 'Conversa transferida pela IA',
          body: `A IA te passou a conversa com ${who}`,
        })
      } catch (err) {
        console.error('[ai transfer] notificação falhou:', err)
      }
    }

    return result
  } catch (err) {
    console.error('[ai transfer] falhou:', err)
    return result
  }
}

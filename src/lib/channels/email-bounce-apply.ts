// ============================================================
// 📭 Devolução de e-mail — o que fazer com ela. Worker-safe (sem
// 'server-only'): o gmail-poll chama daqui; o webhook de e-mail também.
//
// 15/09 (GoLink/Vale Ouro): a devolução da cobrança virou contato/conversa
// falsos, a mensagem seguiu "enviada" e a régua ia repetir o envio. Agora:
//   1. acha o NOSSO envio que voltou (Message-ID, só na mesma conta, só
//      mensagem de agente/robô que saiu de verdade) — sem casamento, só log:
//      um aviso de devolução qualquer não suprime nem cria nada;
//   2. marca esse envio como falhou;
//   3. suprime o endereço (email_bounces) só se a falha é do ENDEREÇO (não
//      existe, domínio não recebe — nunca caixa cheia nem filtro de spam) e o
//      endereço é mesmo do cliente (contato, Asaas ou o To do próprio envio)
//      — um encaminhamento que voltou não pode bloquear o e-mail certo;
//   4. deixa uma nota interna na conversa original, idempotente pelo
//      message_id "dsn:<id original>:<destinatário>".
// Nunca usa applyStatusUpdate (busca por message_id sem escopo de conta).
// Cada passo tem seu try/catch; nunca lança.
// ============================================================

import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, asaasCharges, contacts, conversations, emailBounces, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { ChannelCtx } from '@/lib/channels/provider'
import { publishEvent } from '@/lib/events/publish'

import { bounceNoteText, emailAddressesIn, isAddressFailure, type DeliveryReport } from './email-bounce'

export type BounceOutcome = 'matched' | 'unmatched' | 'ignored'

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Endereços que são mesmo do cliente desta conversa: contato + parcelas do Asaas. */
async function customerAddresses(accountId: string, contactId: string): Promise<Set<string>> {
  const contact = firstOrNull(
    await db
      .select({ email: contacts.email, externalId: contacts.externalId })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  const charges = await db
    .selectDistinct({ email: asaasCharges.email })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, accountId),
        eq(asaasCharges.contactId, contactId),
        sql`nullif(trim(${asaasCharges.email}), '') IS NOT NULL`,
      ),
    )
    .limit(50)
  return new Set(
    [contact?.email, contact?.externalId, ...charges.map((c) => c.email)].flatMap((v) => emailAddressesIn(v)),
  )
}

export async function applyEmailBounce(
  ch: Pick<ChannelCtx, 'id' | 'accountId'>,
  report: DeliveryReport,
): Promise<BounceOutcome> {
  const tag = `canal=${ch.id} dsn=${report.dsnMessageId ?? '-'}`
  if (!report.trusted) {
    console.warn('[email-bounce] aviso de devolução de remetente não confiável — ignorado %s', tag)
    return 'ignored'
  }
  if (!report.failed) {
    console.info('[email-bounce] aviso sem falha (atraso ou entrega) — nada a fazer %s', tag)
    return 'ignored'
  }
  if (!report.originalMessageIds.length) {
    console.warn('[email-bounce] devolução sem Message-ID do envio original %s', tag)
    return 'unmatched'
  }

  // 1. O envio que voltou — mesma conta; o mesmo canal primeiro.
  let orig: {
    id: string
    conversationId: string
    messageId: string | null
    contactId: string | null
    createdAt: string | null
  } | null = null
  try {
    orig = firstOrNull(
      await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          messageId: messages.messageId,
          contactId: conversations.contactId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            inArray(messages.messageId, report.originalMessageIds),
            eq(conversations.accountId, ch.accountId),
            inArray(messages.senderType, ['agent', 'bot']),
            eq(messages.isInternal, false),
          ),
        )
        .orderBy(sql`CASE WHEN ${conversations.channelId} = ${ch.id} THEN 0 ELSE 1 END`, desc(sql`coalesce(${messages.createdAt}, '-infinity'::timestamptz)`))
        .limit(1),
    )
  } catch (err) {
    console.error('[email-bounce] busca do envio original falhou %s: %s', tag, errText(err))
    return 'unmatched'
  }
  if (!orig) {
    console.warn('[email-bounce] devolução sem envio nosso correspondente %s ids=%s', tag, report.originalMessageIds.join(' '))
    return 'unmatched'
  }

  // 2. O envio não chegou.
  try {
    await db
      .update(messages)
      .set({ status: 'failed' })
      .where(and(eq(messages.id, orig.id), inArray(messages.status, ['sending', 'sent', 'delivered'])))
  } catch (err) {
    console.error('[email-bounce] marcar envio %s como falhou deu erro %s: %s', orig.id, tag, errText(err))
  }

  let candidates = new Set<string>()
  if (orig.contactId) {
    try {
      candidates = await customerAddresses(ch.accountId, orig.contactId)
    } catch (err) {
      // Sem saber os e-mails do cliente, não suprime (a nota ainda sai).
      console.error('[email-bounce] e-mails do contato %s não carregaram %s: %s', orig.contactId, tag, errText(err))
    }
  }
  // O To do próprio envio (cópia dos cabeçalhos no aviso) também é do cliente:
  // o lembrete manda pro e-mail que veio da API do Asaas, que pode não estar
  // nem no contato nem na carteira.
  for (const a of report.originalRecipients) candidates.add(a)

  const originalId = (orig.messageId ?? report.originalMessageIds[0]).replace(/^<+/, '').replace(/>+$/, '')
  let notified = false

  const failedRecipients = report.recipients.filter((r) => r.action === 'failed')
  const ours = failedRecipients.filter((r) => candidates.has(r.address))
  // Destinatário que não é do cliente (encaminhamento, lista enorme num aviso
  // forjado) não ganha nota própria nem supressão: no máximo UMA nota geral.
  const noteTargets = ours.length ? ours.map((r) => ({ r, key: r.address })) : failedRecipients.slice(0, 1).map((r) => ({ r, key: 'outros' }))
  if (!ours.length && failedRecipients.length) {
    console.warn('[email-bounce] nenhum destinatário do aviso é e-mail do cliente — só nota, sem supressão %s', tag)
  }

  for (const { r, key } of noteTargets) {
    const noteMessageId = `dsn:${originalId}:${key}`

    let noteExists = false
    try {
      noteExists = !!firstOrNull(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.conversationId, orig.conversationId), eq(messages.messageId, noteMessageId)))
          .limit(1),
      )
    } catch (err) {
      console.error('[email-bounce] checar nota existente falhou %s: %s', tag, errText(err))
    }

    // 3. Supressão: só falha do ENDEREÇO de um e-mail que é do cliente.
    let suppressed = false
    if (key !== 'outros' && isAddressFailure(r)) {
      try {
        const values = {
          accountId: ch.accountId,
          address: r.address,
          contactId: orig.contactId,
          channelId: ch.id,
          messageId: orig.id,
          statusCode: r.status,
          diagnostic: r.diagnostic ? r.diagnostic.slice(0, 1000) : null,
        }
        if (noteExists) {
          // Mesmo aviso lido de novo: garante a linha, sem contar em dobro
          // nem desfazer um "Liberar de novo" que alguém já deu.
          await db.insert(emailBounces).values(values).onConflictDoNothing({ target: [emailBounces.accountId, emailBounces.address] })
        } else {
          // Aviso sobre um envio ANTERIOR ao "Liberar de novo" não desfaz a liberação.
          const sentAt = orig.createdAt
          const keepCleared = sentAt
            ? sql`${emailBounces.clearedAt} IS NOT NULL AND ${emailBounces.clearedAt} > ${sentAt}::timestamptz`
            : sql`false`
          await db
            .insert(emailBounces)
            .values(values)
            .onConflictDoUpdate({
              target: [emailBounces.accountId, emailBounces.address],
              set: {
                lastBouncedAt: sql`now()`,
                bounceCount: sql`${emailBounces.bounceCount} + 1`,
                statusCode: values.statusCode,
                diagnostic: values.diagnostic,
                contactId: values.contactId,
                channelId: values.channelId,
                messageId: values.messageId,
                clearedAt: sql`CASE WHEN ${keepCleared} THEN ${emailBounces.clearedAt} ELSE NULL END`,
                clearedBy: sql`CASE WHEN ${keepCleared} THEN ${emailBounces.clearedBy} ELSE NULL END`,
              },
            })
        }
        suppressed = true
      } catch (err) {
        console.error('[email-bounce] supressão do endereço falhou %s: %s', tag, errText(err))
      }
    }

    // 4. Nota interna na conversa do envio (não reordena a caixa).
    if (noteExists) continue
    try {
      const inserted = await db
        .insert(messages)
        .values({
          conversationId: orig.conversationId,
          accountId: ch.accountId,
          senderType: 'bot',
          contentType: 'text',
          contentText: bounceNoteText(report, r, { suppressed }),
          isInternal: true,
          status: 'sent',
          messageId: noteMessageId,
        })
        .onConflictDoNothing({
          target: [messages.conversationId, messages.messageId],
          where: sql`message_id IS NOT NULL`,
        })
        .returning({ id: messages.id })
      if (inserted.length) notified = true
    } catch (err) {
      console.error('[email-bounce] nota interna falhou %s: %s', tag, errText(err))
    }
  }

  if (notified) {
    try {
      await publishEvent(ch.accountId, { type: 'message.received', conversationId: orig.conversationId, fromMe: true })
    } catch (err) {
      console.error('[email-bounce] aviso em tempo real falhou %s: %s', tag, errText(err))
    }
  }
  return 'matched'
}

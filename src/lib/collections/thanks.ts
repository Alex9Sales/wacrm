// ============================================================
// 🧾 Agradecer quando o pagamento entra (lacuna 1, 07/09).
//
// Disparado pelo webhook do Asaas ao FECHAR uma cobrança que estava aberta.
// Só fala com quem já ouviu a gente por aqui: houve toque da régua para o
// contato, ou a cobrança nasceu no CRM (IA/manual). Pagamento de quem nunca
// foi cobrado pelo CRM não gera mensagem — seria uma empresa estranha
// mandando "obrigado" do nada. Uma vez por cobrança (registro em
// agent_action_requests com tipo próprio, fora da fila e do painel).
//
// Sem 'server-only' — a rota do webhook e o worker alcançam isso.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, collectionsTouches, contacts, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { engineSendText } from '@/lib/flows/meta-send'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

import { resolveCollectionTargets } from './outreach'
import { normalizeSettings } from './rules'
import { seedFromId, thankYouMessage } from './thanks-text'

/** Tipo próprio: não é ação do catálogo, então não entra na fila nem nas métricas de cobrança. */
export const THANKS_ACTION = 'collect_thanks'

export interface ThanksOutcome {
  sent: boolean
  /** Por que não mandou (ou por onde mandou). */
  why: string
}

export async function sendPaymentThanks(args: { accountId: string; chargeId: string; contactId: string }): Promise<ThanksOutcome> {
  const settings = normalizeSettings((await getAccountSettings(args.accountId)).collections)
  if (!settings.thankOnPayment) return { sent: false, why: 'agradecimento desligado na conta' }

  const charge = firstOrNull(
    await db
      .select({
        id: asaasCharges.id,
        asaasId: asaasCharges.asaasId,
        value: asaasCharges.value,
        origin: asaasCharges.origin,
        conversationId: asaasCharges.conversationId,
      })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.id, args.chargeId), eq(asaasCharges.accountId, args.accountId)))
      .limit(1),
  )
  if (!charge) return { sent: false, why: 'cobrança não encontrada' }

  const contact = firstOrNull(
    await db
      .select({ name: contacts.name, optedOut: contacts.optedOut })
      .from(contacts)
      .where(and(eq(contacts.id, args.contactId), eq(contacts.accountId, args.accountId)))
      .limit(1),
  )
  if (!contact) return { sent: false, why: 'contato não encontrado' }
  if (contact.optedOut) return { sent: false, why: 'contato pediu para não receber mensagens' }

  // Só quem já foi cobrado por aqui (ou cuja cobrança nasceu aqui).
  const touch = firstOrNull(
    await db
      .select({ lastTouchAt: collectionsTouches.lastTouchAt })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, args.accountId), eq(collectionsTouches.contactId, args.contactId)))
      .limit(1),
  )
  const cobradoAqui = !!touch?.lastTouchAt || charge.origin === 'ai' || charge.origin === 'manual'
  if (!cobradoAqui) return { sent: false, why: 'o CRM nunca cobrou este cliente — sem agradecimento' }

  // Uma vez por cobrança.
  const already = firstOrNull(
    await db
      .select({ id: agentActionRequests.id })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, args.accountId),
          eq(agentActionRequests.actionType, THANKS_ACTION),
          sql`${agentActionRequests.payload}->>'chargeId' = ${charge.id}`,
        ),
      )
      .limit(1),
  )
  if (already) return { sent: false, why: 'já agradecido' }

  const targets = await resolveCollectionTargets(args.accountId, args.contactId, charge.conversationId ?? null)
  if (!targets.ok) return { sent: false, why: targets.error }

  const firstName = (contact.name ?? '').trim().split(/\s+/)[0] || null
  const text = thankYouMessage(firstName, Number(charge.value ?? 0), seedFromId(charge.id))
  const sentVia: string[] = []
  let conversationId: string | null = null

  if (targets.whatsapp) {
    const userId = await senderUserId(args.accountId)
    if (userId) {
      try {
        await engineSendText({ accountId: args.accountId, userId, conversationId: targets.whatsapp.conversationId, contactId: args.contactId, text })
        sentVia.push('whatsapp')
        conversationId = targets.whatsapp.conversationId
      } catch (err) {
        console.error('[cobranca] agradecimento por WhatsApp falhou:', err instanceof Error ? err.message : err)
      }
    }
  }
  if (targets.email && !sentVia.length) {
    try {
      await sendMessageToConversation(args.accountId, {
        conversationId: targets.email.conversationId,
        messageType: 'text',
        contentText: text,
        subject: 'Pagamento recebido — obrigado',
      })
      sentVia.push('email')
      conversationId = targets.email.conversationId
    } catch (err) {
      console.error('[cobranca] agradecimento por e-mail falhou:', err instanceof Error ? err.message : err)
    }
  }
  if (!sentVia.length) return { sent: false, why: 'nenhum canal conseguiu enviar' }

  const now = new Date().toISOString()
  await db.insert(agentActionRequests).values({
    accountId: args.accountId,
    contactId: args.contactId,
    conversationId,
    actionType: THANKS_ACTION,
    payload: { chargeId: charge.id, asaasId: charge.asaasId, value: Number(charge.value ?? 0), sentVia },
    suggestedText: text,
    reason: 'Pagamento recebido — agradecimento automático',
    decision: 'auto',
    policy: 'collections.thankOnPayment · só para quem o CRM cobrou',
    status: 'sent',
    executedAt: now,
    resolvedAt: now,
  })
  return { sent: true, why: sentVia.join('+') }
}

/** Quem assina o envio: dono da conta, senão um admin, senão qualquer membro. */
async function senderUserId(accountId: string): Promise<string | null> {
  const rows = await db.select({ userId: member.userId, role: member.role }).from(member).where(eq(member.organizationId, accountId))
  const pick = rows.find((r) => r.role === 'owner') ?? rows.find((r) => r.role === 'admin') ?? rows[0]
  return pick?.userId ?? null
}

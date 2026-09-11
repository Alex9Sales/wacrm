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

import { and, asc, eq, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, collectionsTouches, contacts, member } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { engineSendText } from '@/lib/flows/meta-send'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

import { localParts } from './engine'
import { resolveCollectionTargets } from './outreach'
import { dayBlockedReason, greetingName, normalizeSettings, withinWindow } from './rules'
import { localDayKey } from './stale'
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

  const firstName = greetingName(contact.name)
  const text = thankYouMessage(firstName, Number(charge.value ?? 0), seedFromId(charge.id))

  // ⏰ 11/09 (Alex): "prende o agradecimento na janela também". O webhook do
  // Asaas chega na hora do pagamento — inclusive 22h de domingo. Mas NÃO se
  // engole o agradecimento: ele fica esperando e sai quando a janela abrir
  // (sendDuePaymentThanks, chamado pelo worker a cada minuto).
  const settingsAll = await getAccountSettings(args.accountId)
  const tz = settingsAll.businessTimezone || 'America/Sao_Paulo'
  const { hour, weekday } = localParts(tz)
  const hojeKey = localDayKey(tz)
  const foraDaJanela = dayBlockedReason(weekday, settings, hojeKey) ?? (withinWindow(hour, weekday, settings, hojeKey) ? null : 'Fora do horário')
  if (foraDaJanela) {
    const agora = new Date().toISOString()
    await db.insert(agentActionRequests).values({
      accountId: args.accountId,
      contactId: args.contactId,
      conversationId: charge.conversationId ?? null,
      actionType: THANKS_ACTION,
      payload: { chargeId: charge.id, asaasId: charge.asaasId, value: Number(charge.value ?? 0), heldAt: agora },
      suggestedText: text,
      reason: `Pagamento recebido — agradecimento em espera (${foraDaJanela.toLowerCase()})`,
      decision: 'auto',
      policy: 'collections.thankOnPayment · espera a janela de atendimento',
      status: 'pending',
    })
    return { sent: false, why: `${foraDaJanela.toLowerCase()} — vai sair quando a janela abrir` }
  }

  const targets = await resolveCollectionTargets(args.accountId, args.contactId, charge.conversationId ?? null)
  if (!targets.ok) return { sent: false, why: targets.error }

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

/**
 * Agradecimento que ficou ESPERANDO a janela abrir. Uma por chamada — o worker
 * passa a cada minuto, então um fim de semana inteiro drena sem virar rajada
 * na segunda de manhã (é a mesma prudência do sender da régua).
 *
 * Agradecimento velho não sai: passou de `MAX_ESPERA_DIAS`, "obrigado pelo
 * pagamento" já soa estranho — melhor calar do que chegar atrasado.
 */
const MAX_ESPERA_DIAS = 3

export async function sendDuePaymentThanks(accountId: string, now = new Date()): Promise<ThanksOutcome> {
  const settingsAll = await getAccountSettings(accountId)
  const settings = normalizeSettings(settingsAll.collections)
  if (!settings.thankOnPayment) return { sent: false, why: 'agradecimento desligado na conta' }

  const tz = settingsAll.businessTimezone || 'America/Sao_Paulo'
  const { hour, weekday } = localParts(tz)
  const hojeKey = localDayKey(tz, now)
  if (dayBlockedReason(weekday, settings, hojeKey)) return { sent: false, why: 'dia fora da régua' }
  if (!withinWindow(hour, weekday, settings, hojeKey)) return { sent: false, why: 'fora do horário' }

  const velho = new Date(now.getTime() - MAX_ESPERA_DIAS * 86_400_000).toISOString()
  const pendente = firstOrNull(
    await db
      .select({ id: agentActionRequests.id, contactId: agentActionRequests.contactId, payload: agentActionRequests.payload, createdAt: agentActionRequests.createdAt })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, THANKS_ACTION),
          eq(agentActionRequests.status, 'pending'),
        ),
      )
      .orderBy(asc(agentActionRequests.createdAt))
      .limit(1),
  )
  if (!pendente) return { sent: false, why: 'nada em espera' }

  if (pendente.createdAt && pendente.createdAt < velho) {
    await db
      .update(agentActionRequests)
      .set({ status: 'expired', resolvedAt: now.toISOString(), error: `Esperou mais de ${MAX_ESPERA_DIAS} dias pela janela — agradecer agora ficaria estranho.` })
      .where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: 'agradecimento envelheceu na espera' }
  }

  const chargeId = (pendente.payload as { chargeId?: unknown } | null)?.chargeId
  if (!pendente.contactId || typeof chargeId !== 'string') {
    await db.update(agentActionRequests).set({ status: 'failed', resolvedAt: now.toISOString(), error: 'Agradecimento em espera sem contato ou cobrança.' }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: 'agradecimento em espera sem referência' }
  }

  // O pagamento pode ter sido estornado enquanto esperava — quem manda é o
  // estado de agora, não o do momento em que o webhook chegou.
  const charge = firstOrNull(
    await db
      .select({ open: asaasCharges.open, value: asaasCharges.value, conversationId: asaasCharges.conversationId })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.id, chargeId), eq(asaasCharges.accountId, accountId)))
      .limit(1),
  )
  if (!charge || charge.open) {
    await db.update(agentActionRequests).set({ status: 'expired', resolvedAt: now.toISOString(), error: 'A cobrança voltou a ficar em aberto — agradecimento cancelado.' }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: 'cobrança não está mais paga' }
  }

  const targets = await resolveCollectionTargets(accountId, pendente.contactId, charge.conversationId ?? null)
  if (!targets.ok) {
    await db.update(agentActionRequests).set({ status: 'failed', resolvedAt: now.toISOString(), error: targets.error }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: targets.error }
  }

  const text = (pendente.payload as { texto?: unknown } | null)?.texto
  const corpo = typeof text === 'string' && text.trim() ? text : ((await db.select({ t: agentActionRequests.suggestedText }).from(agentActionRequests).where(eq(agentActionRequests.id, pendente.id)).limit(1))[0]?.t ?? '')
  if (!corpo.trim()) {
    await db.update(agentActionRequests).set({ status: 'failed', resolvedAt: now.toISOString(), error: 'Agradecimento em espera sem texto.' }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: 'agradecimento em espera sem texto' }
  }

  const sentVia: string[] = []
  let conversationId: string | null = null
  if (targets.whatsapp) {
    const userId = await senderUserId(accountId)
    if (userId) {
      try {
        await engineSendText({ accountId, userId, conversationId: targets.whatsapp.conversationId, contactId: pendente.contactId, text: corpo })
        sentVia.push('whatsapp')
        conversationId = targets.whatsapp.conversationId
      } catch (err) {
        console.error('[cobranca] agradecimento em espera falhou no WhatsApp:', err instanceof Error ? err.message : err)
      }
    }
  }
  if (targets.email && !sentVia.length) {
    try {
      await sendMessageToConversation(accountId, {
        conversationId: targets.email.conversationId,
        messageType: 'text',
        contentText: corpo,
        subject: 'Pagamento recebido — obrigado',
      })
      sentVia.push('email')
      conversationId = targets.email.conversationId
    } catch (err) {
      console.error('[cobranca] agradecimento em espera falhou no e-mail:', err instanceof Error ? err.message : err)
    }
  }
  if (!sentVia.length) return { sent: false, why: 'nenhum canal conseguiu enviar' }

  const iso = now.toISOString()
  await db
    .update(agentActionRequests)
    .set({
      status: 'sent',
      conversationId,
      executedAt: iso,
      resolvedAt: iso,
      payload: { ...((pendente.payload ?? {}) as Record<string, unknown>), sentVia, heldUntil: iso },
    })
    .where(eq(agentActionRequests.id, pendente.id))
  return { sent: true, why: sentVia.join('+') }
}

// ============================================================
// 🧾 Agradecer quando o pagamento entra (lacuna 1, 07/09).
//
// Disparado pelo webhook do Asaas. Dois caminhos, a mesma regra de fundo —
// só falamos com quem JÁ OUVIU a gente por aqui:
//
//   • Carteira (sendPaymentThanks): uma cobrança VENCIDA que a régua estava
//     cobrando fecha. Prova de que o CRM falou: o toque da régua para o
//     contato, ou a cobrança ter nascido aqui (IA/manual).
//
//   • Pagou em dia (thanksForAdvancePayment, 25/09): quem paga antes de
//     vencer NUNCA entra na carteira — ela é só de vencidas, de propósito.
//     Até aqui o webhook chegava, não reconhecia a cobrança e ficava mudo.
//     Com o aviso do dia do vencimento ligado isso virou um buraco visível:
//     o CRM mandava "vence hoje", o cliente pagava na hora, mandava o
//     comprovante — e ninguém respondia. Aqui a prova de que o CRM falou é
//     o próprio aviso que saiu daqui sobre ESTA parcela (lembrete do D-N ou
//     "vence hoje"). Sem aviso, silêncio: agradecer um pagamento que nunca
//     mencionamos é uma empresa estranha falando do nada.
//
// Uma vez por parcela, nos dois caminhos (registro em agent_action_requests
// com tipo próprio, fora da fila e do painel).
//
// Sem 'server-only' — a rota do webhook e o worker alcançam isso.
// ============================================================

import { and, asc, desc, eq, or, sql, type SQL } from 'drizzle-orm'

import {
  db,
  agentActionRequests,
  asaasCharges,
  collectionsTouches,
  collectionsUpcoming,
  contacts,
  member,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { engineSendText } from '@/lib/flows/meta-send'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'

import { localParts } from './engine'
import { resolveCollectionTargets } from './outreach'
import { collectionGreetingName, normalizeSettings, thanksDayBlockedReason } from './rules'
import { localDayKey } from './stale'
import { seedFromId, thankYouMessage } from './thanks-text'

/** Tipo próprio: não é ação do catálogo, então não entra na fila nem nas métricas de cobrança. */
export const THANKS_ACTION = 'collect_thanks'

export interface ThanksOutcome {
  sent: boolean
  /** Por que não mandou (ou por onde mandou). */
  why: string
}

/** O pagamento que estamos agradecendo, venha ele da carteira ou do aviso. */
interface ThanksSubject {
  /** uuid da carteira — null quando a parcela foi paga em dia e nunca foi espelhada. */
  chargeId: string | null
  /** id da cobrança no Asaas: é por ele que as duas portas não agradecem duas vezes. */
  asaasId: string | null
  value: number
  /** Nome como o Asaas escreve (razão social quando é CNPJ). */
  customerName: string | null
  cpfCnpj: string | null
  conversationId: string | null
  /** Semente do texto: mesma parcela → mesma frase. */
  seedKey: string
  /** Como o registro explica a si mesmo no histórico. */
  policy: string
}

export async function sendPaymentThanks(args: { accountId: string; chargeId: string; contactId: string }): Promise<ThanksOutcome> {
  const settingsAll = await getAccountSettings(args.accountId)
  if (!normalizeSettings(settingsAll.collections).thankOnPayment) {
    return { sent: false, why: 'agradecimento desligado na conta' }
  }

  const charge = firstOrNull(
    await db
      .select({
        id: asaasCharges.id,
        asaasId: asaasCharges.asaasId,
        value: asaasCharges.value,
        origin: asaasCharges.origin,
        conversationId: asaasCharges.conversationId,
        customerName: asaasCharges.customerName,
        cpfCnpj: asaasCharges.cpfCnpj,
      })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.id, args.chargeId), eq(asaasCharges.accountId, args.accountId)))
      .limit(1),
  )
  if (!charge) return { sent: false, why: 'cobrança não encontrada' }

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

  return runThanks(args.accountId, args.contactId, settingsAll, {
    chargeId: charge.id,
    asaasId: charge.asaasId,
    value: Number(charge.value ?? 0),
    customerName: charge.customerName,
    cpfCnpj: charge.cpfCnpj,
    conversationId: charge.conversationId ?? null,
    seedKey: charge.id,
    policy: 'collections.thankOnPayment · só para quem o CRM cobrou',
  })
}

/**
 * Agradece a parcela paga EM DIA — a que nunca entrou na carteira (25/09).
 *
 * Quem autoriza a mensagem é o aviso que o CRM mandou sobre esta mesma
 * parcela. `collections_touches` não serve aqui: ele conta os toques da
 * régua de vencidas, e quem paga em dia nunca é cobrado por ela.
 */
export async function thanksForAdvancePayment(args: {
  accountId: string
  asaasId: string
}): Promise<ThanksOutcome> {
  const settingsAll = await getAccountSettings(args.accountId)
  if (!normalizeSettings(settingsAll.collections).thankOnPayment) {
    return { sent: false, why: 'agradecimento desligado na conta' }
  }

  // O aviso já ENVIADO que cobre esta parcela. Sugestão parada na fila não
  // conta: ninguém do outro lado ouviu nada.
  const aviso = firstOrNull(
    await db
      .select({
        contactId: agentActionRequests.contactId,
        conversationId: agentActionRequests.conversationId,
      })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, args.accountId),
          eq(agentActionRequests.actionType, 'collect_charges'),
          eq(agentActionRequests.status, 'sent'),
          sql`${agentActionRequests.payload}->'asaasIds' @> ${JSON.stringify([args.asaasId])}::jsonb`,
        ),
      )
      .orderBy(desc(agentActionRequests.createdAt))
      .limit(1),
  )
  if (!aviso?.contactId) {
    return { sent: false, why: 'o CRM não avisou esta parcela — sem agradecimento' }
  }

  // Os dados da parcela vivem na lista de próximos vencimentos. Se a leitura
  // já a removeu (ela some do Asaas assim que é paga), o agradecimento ainda
  // sai — sem o valor no texto, que `thankYouMessage` omite sozinho.
  const parcela = firstOrNull(
    await db
      .select({
        value: collectionsUpcoming.value,
        customerName: collectionsUpcoming.customerName,
        cpfCnpj: collectionsUpcoming.cpfCnpj,
      })
      .from(collectionsUpcoming)
      .where(and(eq(collectionsUpcoming.accountId, args.accountId), eq(collectionsUpcoming.asaasId, args.asaasId)))
      .limit(1),
  )

  return runThanks(args.accountId, aviso.contactId, settingsAll, {
    chargeId: null,
    asaasId: args.asaasId,
    value: Number(parcela?.value ?? 0),
    customerName: parcela?.customerName ?? null,
    cpfCnpj: parcela?.cpfCnpj ?? null,
    conversationId: aviso.conversationId ?? null,
    seedKey: args.asaasId,
    policy: 'collections.thankOnPayment · pagou em dia a parcela que avisamos',
  })
}

/** O miolo comum: contato, dedupe, janela de atendimento, envio e registro. */
async function runThanks(
  accountId: string,
  contactId: string,
  settingsAll: Awaited<ReturnType<typeof getAccountSettings>>,
  subject: ThanksSubject,
): Promise<ThanksOutcome> {
  const settings = normalizeSettings(settingsAll.collections)
  const contact = firstOrNull(
    await db
      .select({ name: contacts.name, nameSource: contacts.nameSource, optedOut: contacts.optedOut })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { sent: false, why: 'contato não encontrado' }
  if (contact.optedOut) return { sent: false, why: 'contato pediu para não receber mensagens' }

  // Uma vez por parcela. A chave do Asaas vale para as duas portas: a parcela
  // paga em dia que depois cair na carteira não ganha um segundo obrigado.
  const jaAgradecido: SQL[] = []
  if (subject.chargeId) jaAgradecido.push(sql`${agentActionRequests.payload}->>'chargeId' = ${subject.chargeId}`)
  if (subject.asaasId) jaAgradecido.push(sql`${agentActionRequests.payload}->>'asaasId' = ${subject.asaasId}`)
  if (!jaAgradecido.length) return { sent: false, why: 'pagamento sem referência — sem agradecimento' }
  const already = firstOrNull(
    await db
      .select({ id: agentActionRequests.id })
      .from(agentActionRequests)
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.actionType, THANKS_ACTION),
          or(...jaAgradecido),
        ),
      )
      .limit(1),
  )
  if (already) return { sent: false, why: 'já agradecido' }

  // A mesma saudação da régua (23/09, João/GoLink): com CNPJ o nome do Asaas é
  // razão social — "Tudo certo, Casa da Massa" vira "Tudo certo, Marina"
  // quando a ficha do CRM traz a pessoa que atende.
  const firstName = collectionGreetingName(subject.customerName, contact.name, contact.nameSource, subject.cpfCnpj)
  const text = thankYouMessage(firstName, subject.value, seedFromId(subject.seedKey))

  // ⏰ 11/09 (Alex): "prende o agradecimento na janela também". O webhook do
  // Asaas chega na hora do pagamento — inclusive 22h de domingo. Mas NÃO se
  // engole o agradecimento: ele fica esperando e sai quando a janela abrir
  // (sendDuePaymentThanks, chamado pelo worker a cada minuto).
  const tz = settingsAll.businessTimezone || 'America/Sao_Paulo'
  const { hour, weekday } = localParts(tz)
  const hojeKey = localDayKey(tz)
  // Agradecer tem regra própria: vai no sábado, não vai no domingo nem em
  // feriado, e respeita o horário da conta (11/09, Alex).
  const diaRuim = thanksDayBlockedReason(weekday, settings, hojeKey)
  const foraDoHorario = hour < settings.startHour || hour >= settings.endHour
  const foraDaJanela = diaRuim ?? (foraDoHorario ? 'Fora do horário' : null)
  if (foraDaJanela) {
    const agora = new Date().toISOString()
    await db.insert(agentActionRequests).values({
      accountId,
      contactId,
      conversationId: subject.conversationId,
      actionType: THANKS_ACTION,
      payload: {
        ...(subject.chargeId ? { chargeId: subject.chargeId } : {}),
        asaasId: subject.asaasId,
        value: subject.value,
        heldAt: agora,
      },
      suggestedText: text,
      reason: `Pagamento recebido — agradecimento em espera (${foraDaJanela.toLowerCase()})`,
      decision: 'auto',
      policy: 'collections.thankOnPayment · espera a janela de atendimento',
      status: 'pending',
    })
    return { sent: false, why: `${foraDaJanela.toLowerCase()} — vai sair quando a janela abrir` }
  }

  const targets = await resolveCollectionTargets(accountId, contactId, subject.conversationId)
  if (!targets.ok) return { sent: false, why: targets.error }

  const sentVia: string[] = []
  let conversationId: string | null = null

  if (targets.whatsapp) {
    const userId = await senderUserId(accountId)
    if (userId) {
      try {
        await engineSendText({ accountId, userId, conversationId: targets.whatsapp.conversationId, contactId, text })
        sentVia.push('whatsapp')
        conversationId = targets.whatsapp.conversationId
      } catch (err) {
        console.error('[cobranca] agradecimento por WhatsApp falhou:', err instanceof Error ? err.message : err)
      }
    }
  }
  if (targets.email && !sentVia.length) {
    try {
      await sendMessageToConversation(accountId, {
        conversationId: targets.email.conversationId,
        messageType: 'text',
        contentText: text,
        subject: 'Pagamento recebido — obrigado',
        emailTo: targets.email.address,
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
    accountId,
    contactId,
    conversationId,
    actionType: THANKS_ACTION,
    payload: {
      ...(subject.chargeId ? { chargeId: subject.chargeId } : {}),
      asaasId: subject.asaasId,
      value: subject.value,
      sentVia,
    },
    suggestedText: text,
    reason: 'Pagamento recebido — agradecimento automático',
    decision: 'auto',
    policy: subject.policy,
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
 * Cancela o agradecimento que ainda espera a janela quando o pagamento é
 * desfeito (estorno, chargeback). A parcela paga em dia não tem linha na
 * carteira para `sendDuePaymentThanks` reconferir, então quem avisa que ela
 * voltou a dever é o próprio webhook — ver collections/webhook.ts.
 */
export async function cancelHeldThanks(accountId: string, asaasId: string): Promise<number> {
  const rows = await db
    .update(agentActionRequests)
    .set({
      status: 'expired',
      resolvedAt: new Date().toISOString(),
      error: 'O pagamento foi desfeito no Asaas — agradecimento cancelado.',
    })
    .where(
      and(
        eq(agentActionRequests.accountId, accountId),
        eq(agentActionRequests.actionType, THANKS_ACTION),
        eq(agentActionRequests.status, 'pending'),
        sql`${agentActionRequests.payload}->>'asaasId' = ${asaasId}`,
      ),
    )
    .returning({ id: agentActionRequests.id })
  return rows.length
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
  const diaRuim = thanksDayBlockedReason(weekday, settings, hojeKey)
  if (diaRuim) return { sent: false, why: diaRuim.toLowerCase() }
  if (hour < settings.startHour || hour >= settings.endHour) return { sent: false, why: 'fora do horário' }

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

  const payload = (pendente.payload ?? {}) as { chargeId?: unknown; asaasId?: unknown; texto?: unknown }
  const chargeId = typeof payload.chargeId === 'string' ? payload.chargeId : null
  const asaasId = typeof payload.asaasId === 'string' ? payload.asaasId : null
  if (!pendente.contactId || (!chargeId && !asaasId)) {
    await db.update(agentActionRequests).set({ status: 'failed', resolvedAt: now.toISOString(), error: 'Agradecimento em espera sem contato ou cobrança.' }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: 'agradecimento em espera sem referência' }
  }

  // O pagamento pode ter sido estornado enquanto esperava — quem manda é o
  // estado de agora, não o do momento em que o webhook chegou. A parcela paga
  // EM DIA não tem linha na carteira para conferir: nela o cancelamento vem
  // pelo webhook do estorno (cancelHeldThanks).
  let conversationIdDaCobranca: string | null = null
  if (chargeId) {
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
    conversationIdDaCobranca = charge.conversationId ?? null
  }

  const targets = await resolveCollectionTargets(accountId, pendente.contactId, conversationIdDaCobranca)
  if (!targets.ok) {
    await db.update(agentActionRequests).set({ status: 'failed', resolvedAt: now.toISOString(), error: targets.error }).where(eq(agentActionRequests.id, pendente.id))
    return { sent: false, why: targets.error }
  }

  const text = payload.texto
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
        emailTo: targets.email.address,
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

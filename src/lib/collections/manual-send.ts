// ============================================================
// 🧾 "Cobrar pelo WhatsApp" — cobrança de UM devedor, à mão, pela carteira.
//
// 22/09 (João/GoLink): "quero cobrar esse cliente agora, pelo MEU número,
// sem esperar a régua". A régua automática (engine → sender →
// executeOrchestrationAction) FORÇA o número escolhido em Ajustar e grava a
// mensagem como do robô; aqui é uma pessoa mandando, pelo número dela, com o
// texto da régua já pronto na tela pra revisar.
//
// IGUAL à régua, de propósito: o texto sai dos mesmos números
// (formatDebtSummary/fallbackMessage, mesmas opções de Ajustar), a IA que
// reescreve é a mesma (draftCollectionMessage), o freio do devedor é o mesmo
// (debtorHold), o portão de template da API oficial é o mesmo
// (officialTemplateGate) e o envio CONTA COMO TOQUE (recordCollectionTouch
// com kind 'manual'): a régua não repete a cobrança logo em seguida e o painel
// "Envios da régua" mostra o envio (pedido gravado já como 'sent').
//
// DIFERENTE: o número é o que a pessoa escolheu (padrão: o dela), a mensagem
// é gravada como de gente (sendMessageToConversation, senderType 'agent') com
// a assinatura de QUEM CLICOU, sem janela de horário/feriado (é uma pessoa
// decidindo) e sem entregar a conversa a "quem cuida das respostas" — a
// conversa do Vitor continua do Vitor.
//
// Regras puras (testadas): manual-send-rules.ts. Sem 'server-only'.
// ============================================================

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { db, agentActionRequests, aiConfigs, asaasCharges, asaasConnections, channels, collectionsTouches, contacts, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { channelOwnerLabel } from '@/lib/broadcasts/channel-choice'
import { otherPersonNumberError } from '@/lib/broadcasts/channel-owner-guard'
import { officialTemplateGate, recordCollectionTouch } from '@/lib/orchestration/actions'
import { findDeliveredWhatsAppCopy } from './delivered-copy'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { ensureConversationForContact } from '@/lib/whatsapp/resolve-conversation'
import { friendlySendError, sendMessageToConversation } from '@/lib/whatsapp/send-message'

import { draftCollectionMessage, localParts } from './engine'
import {
  MANUAL_COLLECT_KIND,
  MANUAL_COLLECT_MAX_CHARS,
  daysLateOn,
  defaultManualCollectChannelId,
  hasOverdueOpenCharge,
  manualCollectChannelLabel,
  manualCollectExpireReason,
  manualCollectRequestValues,
  manualHoldReason,
  momentLabel,
  signManualCollectText,
  type ManualCollectChannel,
} from './manual-send-rules'
import { WHATSAPP_PROVIDERS } from './outreach'
import {
  countsAsOverdue,
  debtorHold,
  fallbackMessage,
  formatDebtSummary,
  normalizeSettings,
  type ChargeLine,
  type CollectionsSettings,
  collectionGreetingName,
} from './rules'
import { localDayKey } from './stale'
import { seedFrom } from './variation'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ManualCollectOutcome<T> = { ok: true; data: T } | { ok: false; error: string }

export interface ManualCollectChannelOption {
  id: string
  /** "Cobranças (seu número)" — nome + de quem é. */
  label: string
  /** "seu número" / "número de Vitor" / null (da empresa). */
  ownerLabel: string | null
  isMine: boolean
  /** É o "Número que envia as cobranças" de Ajustar. */
  isRuleChannel: boolean
}

export interface ManualCollectPrepared {
  /** Texto determinístico da régua (fallbackMessage), pronto pra editar. */
  text: string
  /** Só números de WhatsApp CONECTADOS. */
  channels: ManualCollectChannelOption[]
  defaultChannelId: string | null
  /** Número da régua (Ajustar); null = automático. Pra avisar quando a escolha é outra. */
  ruleChannelId: string | null
  /** Freio do devedor (pausa / promessa): a tela mostra o motivo e exige "Enviar mesmo assim". */
  hold: { blocked: boolean; reason: string | null }
  /** Toques já registrados — o envio será o Nº touchCount + 1. */
  touchCount: number
  summary: { lines: string[]; total: number; showValues: boolean }
}

export interface ManualCollectSendInput {
  contactId: string
  text: string
  channelId: string
  /** A pessoa confirmou usar o número dedicado a OUTRA pessoa. */
  confirmOtherNumber?: boolean
  /** A pessoa marcou "Enviar mesmo assim" com o devedor pausado/prometido. */
  overrideHold?: boolean
}

export interface ManualCollectSent {
  conversationId: string
  channelLabel: string
  /** Nº do toque que este envio foi. */
  touch: number
  /** API oficial fora da janela de 24 h: saiu o template de Ajustar, não o texto editado. */
  sentAsTemplate: boolean
  /** false = a mensagem SAIU, mas o registro (toque/painel) falhou — a régua pode repetir. */
  recorded: boolean
  /** O canal devolveu erro, mas a mensagem já estava na conversa: adotada, não reenviada. */
  adoptedFromEcho?: boolean
}

// ------------------------------------------------------------- o devedor

interface TouchRow {
  paused: boolean
  pausedReason: string | null
  snoozeUntil: string | null
  snoozeReason: string | null
  touchCount: number
  lastTouchAt: string | null
  recentTexts: string[]
}

interface DebtorContext {
  contact: { id: string; name: string | null; phone: string | null; optedOut: boolean }
  settings: CollectionsSettings
  tz: string
  signatureEnabled: boolean
  touch: TouchRow | null
  /** Só as VENCIDAS em aberto, como a régua monta a mensagem. */
  charges: ChargeLine[]
  /** Tudo que está aberto (a reconferência decide com o predicado puro). */
  openRows: { open: boolean; dueDate: string | null }[]
  /** Nome como está no Asaas — prevalece na saudação (João/Alex 10/09). */
  asaasName: string | null
  todayKey: string
}

async function loadDebtor(accountId: string, contactId: string): Promise<ManualCollectOutcome<DebtorContext>> {
  if (!UUID_RE.test(contactId)) return { ok: false, error: 'Contato inválido.' }
  const contact = firstOrNull(
    await db
      .select({ id: contacts.id, name: contacts.name, phone: contacts.phone, optedOut: contacts.optedOut })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!contact) return { ok: false, error: 'Contato não encontrado nesta conta.' }

  const all = await getAccountSettings(accountId)
  const settings = normalizeSettings(all.collections)
  const tz = all.businessTimezone || 'America/Sao_Paulo'
  const todayKey = localDayKey(tz)

  const touchRow = firstOrNull(
    await db
      .select({
        paused: collectionsTouches.paused,
        pausedReason: collectionsTouches.pausedReason,
        snoozeUntil: collectionsTouches.snoozeUntil,
        snoozeReason: collectionsTouches.snoozeReason,
        touchCount: collectionsTouches.touchCount,
        lastTouchAt: collectionsTouches.lastTouchAt,
        recentTexts: collectionsTouches.recentTexts,
      })
      .from(collectionsTouches)
      .where(and(eq(collectionsTouches.accountId, accountId), eq(collectionsTouches.contactId, contactId)))
      .limit(1),
  )
  const touch: TouchRow | null = touchRow
    ? {
        ...touchRow,
        touchCount: touchRow.touchCount ?? 0,
        recentTexts: Array.isArray(touchRow.recentTexts) ? touchRow.recentTexts.filter((t): t is string => typeof t === 'string') : [],
      }
    : null

  const rows = await db
    .select({
      customerId: asaasCharges.asaasCustomerId,
      connectionId: asaasCharges.connectionId,
      cpfCnpj: asaasCharges.cpfCnpj,
      customerName: asaasCharges.customerName,
      value: asaasCharges.value,
      interestValue: asaasCharges.interestValue,
      dueDate: asaasCharges.dueDate,
      invoiceUrl: asaasCharges.invoiceUrl,
      open: asaasCharges.open,
      connectionLabel: asaasConnections.label,
    })
    .from(asaasCharges)
    .innerJoin(asaasConnections, eq(asaasConnections.id, asaasCharges.connectionId))
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), eq(asaasCharges.open, true)))
    .orderBy(asc(asaasCharges.dueDate))

  const charges: ChargeLine[] = []
  let asaasName: string | null = null
  for (const r of rows) {
    const late = daysLateOn(r.dueDate, todayKey)
    // Só o que VENCEU entra na mensagem — parcela a vencer é assunto do lembrete.
    if (!countsAsOverdue(late)) continue
    if (asaasName == null) asaasName = (r.customerName ?? '').trim() || null
    charges.push({
      customerId: r.customerId,
      connectionId: r.connectionId,
      document: r.cpfCnpj,
      customerName: r.customerName,
      value: Number(r.value ?? 0),
      interestValue: r.interestValue != null ? Number(r.interestValue) : null,
      dueDate: r.dueDate,
      daysLate: late,
      connectionLabel: r.connectionLabel,
      invoiceUrl: r.invoiceUrl,
    })
  }

  return {
    ok: true,
    data: {
      contact: { id: contact.id, name: contact.name, phone: contact.phone, optedOut: contact.optedOut === true },
      settings,
      tz,
      signatureEnabled: all.agentSignatureEnabled === true,
      touch,
      charges,
      openRows: rows.map((r) => ({ open: r.open, dueDate: r.dueDate })),
      asaasName,
      todayKey,
    },
  }
}

/** Números de WhatsApp da conta, com o dono de cada um (dedicated_user_id). */
async function listWhatsAppChannels(accountId: string): Promise<ManualCollectChannel[]> {
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      status: channels.status,
      dedicated_user_id: channels.dedicatedUserId,
      dedicated_user_name: user.name,
    })
    .from(channels)
    .leftJoin(user, eq(user.id, channels.dedicatedUserId))
    .where(and(eq(channels.accountId, accountId), inArray(channels.provider, [...WHATSAPP_PROVIDERS])))
    .orderBy(asc(channels.name))
  return rows.map((r) => ({ ...r, dedicated_user_name: r.dedicated_user_name ?? null }))
}

/** Mesma chave de dia da régua (engine.ts usa o dia UTC na semente). */
const utcDayKey = () => new Date().toISOString().slice(0, 10)

const NO_OVERDUE = 'Este cliente não tem parcela vencida em aberto — nada para cobrar.'

// ------------------------------------------------------------- preparar

export async function prepareManualCollectCore(accountId: string, userId: string, contactId: string): Promise<ManualCollectOutcome<ManualCollectPrepared>> {
  const loaded = await loadDebtor(accountId, contactId)
  if (!loaded.ok) return loaded
  const ctx = loaded.data
  if (!ctx.charges.length) return { ok: false, error: NO_OVERDUE }

  const connected = (await listWhatsAppChannels(accountId)).filter((c) => c.status === 'connected')
  if (!connected.length) return { ok: false, error: 'Nenhum número de WhatsApp conectado nesta conta — conecte um em Canais.' }

  const summary = formatDebtSummary(ctx.charges, { showValues: ctx.settings.showValues })
  const touchCount = ctx.touch?.touchCount ?? 0
  const text = fallbackMessage(collectionGreetingName(ctx.asaasName, ctx.contact.name), summary, touchCount, seedFrom(contactId, touchCount, utcDayKey()), {
    offerDate: ctx.settings.offerDateNegotiation,
  })
  const hold = debtorHold(ctx.touch, null)

  return {
    ok: true,
    data: {
      text,
      channels: connected.map((c) => ({
        id: c.id,
        label: manualCollectChannelLabel(c, userId),
        ownerLabel: channelOwnerLabel(c, userId),
        isMine: c.dedicated_user_id === userId,
        isRuleChannel: c.id === ctx.settings.channelId,
      })),
      defaultChannelId: defaultManualCollectChannelId(connected, userId, ctx.settings.channelId),
      ruleChannelId: ctx.settings.channelId,
      hold: { blocked: hold != null, reason: manualHoldReason(hold, ctx.touch ?? {}) },
      touchCount,
      summary: { lines: summary.lines, total: summary.total, showValues: summary.showValues },
    },
  }
}

// ------------------------------------------------------------- reescrever com IA

/**
 * Uma chamada de IA, só quando a pessoa pede. A IA é a mesma da régua
 * (agente padrão da conta) e recebe as últimas cobranças enviadas a este
 * devedor pra não repetir. Se a IA não responder, a pessoa fica sabendo — o
 * texto padrão que já está na tela continua valendo.
 */
export async function draftManualCollectWithAiCore(accountId: string, contactId: string): Promise<ManualCollectOutcome<{ text: string }>> {
  const loaded = await loadDebtor(accountId, contactId)
  if (!loaded.ok) return loaded
  const ctx = loaded.data
  if (!ctx.charges.length) return { ok: false, error: NO_OVERDUE }

  const agent = firstOrNull(
    await db
      .select({ id: aiConfigs.id })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
  if (!agent) return { ok: false, error: 'Nenhum agente de IA configurado nesta conta — o texto padrão continua valendo.' }

  const summary = formatDebtSummary(ctx.charges, { showValues: ctx.settings.showValues })
  const touch = ctx.touch?.touchCount ?? 0
  const { hour, weekday } = localParts(ctx.tz)
  const maxLate = Math.max(...ctx.charges.map((c) => c.daysLate ?? -1))
  const customerName = ctx.asaasName ?? ctx.contact.name
  const firstName = collectionGreetingName(ctx.asaasName, ctx.contact.name)
  // Semente nova a cada clique: "reescrever" de novo tem que dar outra variação.
  const seed = seedFrom(contactId, touch, utcDayKey(), MANUAL_COLLECT_KIND, Date.now())
  const args = { offerDate: ctx.settings.offerDateNegotiation }

  const text = await draftCollectionMessage({
    accountId,
    agentId: agent.id,
    firstName,
    fullName: customerName,
    summary,
    touch,
    tone: ctx.settings.tone,
    offerDate: args.offerDate,
    maxDaysLate: Number.isFinite(maxLate) ? maxLate : null,
    previousTexts: ctx.touch?.recentTexts ?? [],
    seed,
    moment: momentLabel(hour, weekday),
  })
  // draftCollectionMessage devolve o texto de segurança em silêncio quando a
  // IA falha (chave sem crédito, modelo fora). Quem clicou pediu IA: avisa.
  if (text === fallbackMessage(firstName, summary, touch, seed, args)) {
    return { ok: false, error: 'A IA não respondeu agora (chave sem crédito ou modelo indisponível) — o texto padrão continua valendo.' }
  }
  return { ok: true, data: { text } }
}

// ------------------------------------------------------------- enviar

export async function sendManualCollectCore(accountId: string, userId: string, input: ManualCollectSendInput): Promise<ManualCollectOutcome<ManualCollectSent>> {
  const text = (input.text ?? '').trim()
  if (!text) return { ok: false, error: 'Escreva a mensagem antes de enviar.' }
  if (text.length > MANUAL_COLLECT_MAX_CHARS) return { ok: false, error: `Mensagem longa demais (máximo de ${MANUAL_COLLECT_MAX_CHARS} caracteres).` }
  if (!UUID_RE.test(input.channelId ?? '')) return { ok: false, error: 'Escolha por qual número enviar.' }

  const loaded = await loadDebtor(accountId, input.contactId)
  if (!loaded.ok) return loaded
  const ctx = loaded.data
  if (ctx.contact.optedOut) return { ok: false, error: 'Este contato pediu para não receber mensagens — a cobrança não foi enviada.' }
  if ((ctx.contact.phone ?? '').replace(/\D/g, '').length < 10) {
    return { ok: false, error: 'Este contato não tem telefone na ficha — a cobrança não sai por WhatsApp.' }
  }

  // O número: existe, está conectado e, se é de outra pessoa, foi confirmado.
  const channel = (await listWhatsAppChannels(accountId)).find((c) => c.id === input.channelId)
  if (!channel) return { ok: false, error: 'Este número não existe mais nesta conta — escolha outro.' }
  if (channel.status !== 'connected') return { ok: false, error: `O número "${channel.name}" está desconectado — reconecte ou escolha outro.` }
  const outraPessoa = await otherPersonNumberError(accountId, userId, channel.id, input.confirmOtherNumber)
  if (outraPessoa) return { ok: false, error: outraPessoa }

  // ✋ Freio do devedor (pausa / promessa): só passa com "Enviar mesmo assim".
  const hold = debtorHold(ctx.touch, null)
  if (hold && !input.overrideHold) {
    return { ok: false, error: `${manualHoldReason(hold, ctx.touch ?? {})} Marque "Enviar mesmo assim" para cobrar.` }
  }

  // Última trava: ainda há parcela VENCIDA em aberto? (open=true sozinho não
  // basta — parcela a vencer também fica aberta na carteira.)
  if (!hasOverdueOpenCharge(ctx.openRows, ctx.todayKey) || !ctx.charges.length) {
    return { ok: false, error: 'Este cliente não tem mais parcela vencida em aberto — a cobrança não foi enviada.' }
  }

  let conversationId: string
  try {
    conversationId = (await ensureConversationForContact(accountId, ctx.contact.id, channel.id, userId)).conversationId
  } catch (err) {
    return { ok: false, error: `Não deu para abrir a conversa: ${err instanceof Error ? err.message : 'falha'}` }
  }

  const sender = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))
  const senderName = sender?.name ?? null

  // 📋 API oficial fora da janela de 24 h: texto livre não é entregue — vai o
  // template de Ajustar, ou recusa dizendo o que resolver (igual à régua).
  let sentAsTemplate = false
  let adoptedFromEcho = false
  const outgoingText = signManualCollectText(text, senderName, ctx.signatureEnabled)
  const summaryForTemplate = formatDebtSummary(ctx.charges, { showValues: ctx.settings.showValues })
  // 📬 O WAHA às vezes devolve erro e ENTREGA (14/09, régua). Um clique que
  // "falhou" há instantes pode já estar na conversa: o mesmo texto para o
  // mesmo devedor, pelo mesmo número, dentro de 2 min, nunca é reenvio
  // legítimo — é o mesmo envio. Confere ANTES de mandar (o 2º clique costuma
  // dar certo, e aí o catch nunca rodaria) e de novo no catch, com uma espera
  // curta para o eco chegar pelo webhook.
  const lookbackIso = new Date(Date.now() - 2 * 60_000).toISOString()
  const copyOf = () =>
    findDeliveredWhatsAppCopy(accountId, { contactId: ctx.contact.id, createdAt: lookbackIso, suggestedText: text }, { conversationId }).catch(() => null)
  try {
    const gate = await officialTemplateGate(accountId, conversationId, {
      kind: 'manual',
      vars: {
        valor: ctx.settings.showValues ? summaryForTemplate.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
        link: summaryForTemplate.links[0] ?? '',
        dias: String(Math.max(0, ...ctx.charges.map((c) => c.daysLate ?? 0))),
        parcelas: String(ctx.charges.length),
      },
    })
    // A flag vem ANTES do await: se o template lançar, o catch precisa saber
    // que foi template — o texto do rascunho nunca reconhece um template.
    sentAsTemplate = gate.needsTemplate
    if (gate.needsTemplate) {
      if (!gate.templateName) {
        return {
          ok: false,
          error:
            'Este número é a API oficial do WhatsApp e o cliente não escreveu nas últimas 24 h, então só um template aprovado é entregue. Escolha o template em Cobranças → Ajustar.',
        }
      }
      await sendMessageToConversation(accountId, {
        conversationId,
        messageType: 'template',
        templateName: gate.templateName,
        templateLanguage: gate.templateLanguage,
        templateParams: gate.params,
      })
    } else {
      const already = await copyOf()
      if (already) {
        adoptedFromEcho = true
        console.warn(`[cobranca] envio à mão: a mesma cobrança já saiu há instantes nesta conversa (${already.id.slice(0, 8)}) — adotada, não reenviada`)
      } else {
        await sendMessageToConversation(accountId, {
          conversationId,
          messageType: 'text',
          contentText: outgoingText,
        })
      }
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    // Antes de recusar, procura a mensagem na conversa (3 tentativas, 1,5 s
    // entre elas — o eco do WAHA chega pelo webhook alguns segundos depois).
    let copy: Awaited<ReturnType<typeof copyOf>> = null
    if (!sentAsTemplate) {
      for (let i = 0; i < 3 && !copy; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500))
        copy = await copyOf()
      }
    }
    if (!copy) return { ok: false, error: friendlySendError(raw) ?? `Não foi possível enviar: ${raw}` }
    adoptedFromEcho = true
    console.warn(`[cobranca] envio à mão: canal devolveu erro mas a mensagem já estava na conversa (${copy.id.slice(0, 8)}) — adotada, não reenviada`)
  }

  // A mensagem JÁ SAIU. Daqui pra baixo é registro — falha vira log e aviso,
  // nunca "não foi possível enviar" (o falso negativo mais caro que existe).
  const touch = (ctx.touch?.touchCount ?? 0) + 1
  const nowIso = new Date().toISOString()
  const summary = formatDebtSummary(ctx.charges, { showValues: ctx.settings.showValues })
  let recorded = true
  try {
    // 1) O toque: ritmo da régua + contador + "não repita isto" da IA.
    await recordCollectionTouch(accountId, ctx.contact.id, text, MANUAL_COLLECT_KIND)
    // 2) O pedido já enviado: painel "Envios da régua", teto do dia, cadência.
    await db.insert(agentActionRequests).values(
      manualCollectRequestValues({
        accountId,
        contactId: ctx.contact.id,
        conversationId,
        channelId: channel.id,
        byUserId: userId,
        touch,
        text,
        lines: summary.lines,
        links: summary.links,
        now: nowIso,
      }),
    )
    // 3) Pedido automático deste contato ainda na fila: sem isto o sender
    //    mandava a MESMA cobrança minutos depois. Só a cobrança da régua —
    //    lembrete, aviso de cobrança nova e aviso do dia são outra parcela
    //    (manualCollectExpiresKind / NOTICE_KINDS — manter os três em dia aqui).
    await db
      .update(agentActionRequests)
      .set({ status: 'expired', error: manualCollectExpireReason(senderName), resolvedAt: nowIso, resolvedBy: userId })
      .where(
        and(
          eq(agentActionRequests.accountId, accountId),
          eq(agentActionRequests.contactId, ctx.contact.id),
          eq(agentActionRequests.actionType, 'collect_charges'),
          inArray(agentActionRequests.status, ['pending', 'queued']),
          sql`${agentActionRequests.payload}->>'kind' IS DISTINCT FROM 'reminder' AND ${agentActionRequests.payload}->>'kind' IS DISTINCT FROM 'new_charge' AND ${agentActionRequests.payload}->>'kind' IS DISTINCT FROM 'due_today'`,
        ),
      )
  } catch (err) {
    recorded = false
    console.error('[cobranca] envio à mão saiu, mas o registro falhou conta=%s contato=%s:', accountId, ctx.contact.id, err instanceof Error ? err.message : err)
  }

  return { ok: true, data: { conversationId, channelLabel: manualCollectChannelLabel(channel, userId), touch, sentAsTemplate, recorded, adoptedFromEcho } }
}

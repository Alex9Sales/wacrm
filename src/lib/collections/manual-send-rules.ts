// ============================================================
// 🧾 "Cobrar pelo WhatsApp" — regras PURAS do envio à mão pela carteira.
//
// 22/09 (João/GoLink): cobrar UM devedor agora, pelo número de quem clica
// (o João pelo dele, o Vitor pelo dele), com o texto da régua já pronto e
// editável — e que CONTE como toque da régua. O fluxo com banco está em
// manual-send.ts; aqui fica o que se testa sem banco: escolha do número
// padrão, assinatura, reconferência de "vencida", motivo do freio, o pedido
// que vai pro painel "Envios da régua" e os textos.
//
// Puro (client-safe): o diálogo importa daqui o texto de sucesso.
// ============================================================

import { channelOwnerLabel, defaultBroadcastChannelId, type BroadcastChannelOwner } from '@/lib/broadcasts/channel-choice'
import { looksLikeBareCode } from '@/lib/whatsapp/bare-code'

import type { DebtorHold } from './rules'
import { paymentRefsPayload } from './payment-refs'
import { NOTICE_KINDS } from './rules'

/** `payload.kind` do pedido gravado — conta como toque (countsAsCollectionTouch). */
export const MANUAL_COLLECT_KIND = 'manual'

/** Teto do texto editado: o WhatsApp corta em 4096 e a cobrança não passa de uns 500. */
export const MANUAL_COLLECT_MAX_CHARS = 4000

export interface ManualCollectChannel extends BroadcastChannelOwner {
  id: string
  name: string
  dedicated_user_id: string | null
  dedicated_user_name: string | null
  status: string
}

/**
 * Qual número vem marcado no "Enviar por". Ordem: meu número → número de
 * ninguém → número da régua (Ajustar) → o primeiro conectado. Entre os "de
 * ninguém", o da régua vem primeiro: é o que o devedor já conhece. Só
 * conectados; sem nenhum, null (a tela explica).
 */
export function defaultManualCollectChannelId(
  list: readonly ManualCollectChannel[],
  userId: string,
  ruleChannelId: string | null,
): string | null {
  const connected = list.filter((c) => c.status === 'connected')
  if (!connected.length) return null
  const ordered = [...connected].sort((a, b) => Number(b.id === ruleChannelId) - Number(a.id === ruleChannelId))
  const pickId = defaultBroadcastChannelId(ordered, userId)
  const pick = ordered.find((c) => c.id === pickId) ?? ordered[0]
  if (pick.dedicated_user_id === userId || !pick.dedicated_user_id) return pick.id
  // Só sobrou número de OUTRA pessoa: o da régua, se estiver entre eles.
  return ordered.find((c) => c.id === ruleChannelId)?.id ?? pick.id
}

/** "Cobranças (seu número)" / "Atendimento" / "Vitor (número de Vitor)". */
export function manualCollectChannelLabel(c: ManualCollectChannel, userId: string): string {
  const owner = channelOwnerLabel(c, userId)
  return owner ? `${c.name} (${owner})` : c.name
}

/**
 * Assinatura "*Nome:*" de QUEM CLICOU — a mesma regra do envio pelo inbox
 * (api/whatsapp/send): só com a opção da conta ligada, e nunca em mensagem
 * que é só código/link (o cliente copia a bolha inteira e o banco recusa).
 */
export function signManualCollectText(text: string, senderName: string | null | undefined, signatureEnabled: boolean): string {
  const name = (senderName ?? '').trim()
  if (!signatureEnabled || !name || looksLikeBareCode(text)) return text
  return `*${name}:*\n${text}`
}

/**
 * A parcela aberta ainda justifica cobrança HOJE: venceu ANTES de hoje (no
 * fuso da conta) ou não tem data. `open=true` sozinho não basta — parcela a
 * vencer também fica aberta na carteira, e cobrá-la como vencida é errado.
 */
export function isOverdueOpenCharge(c: { open: boolean; dueDate: string | null }, todayKey: string): boolean {
  if (!c.open) return false
  if (!c.dueDate) return true
  return c.dueDate.slice(0, 10) < todayKey
}

/** Reconferência antes de enviar: ao menos UMA parcela vencida em aberto. */
export function hasOverdueOpenCharge(rows: readonly { open: boolean; dueDate: string | null }[], todayKey: string): boolean {
  return rows.some((r) => isOverdueOpenCharge(r, todayKey))
}

/**
 * Dias de atraso = diferença de DATAS no fuso da conta (`todayKey`), não de
 * instantes — a mesma conta da régua (engine.ts): às 10h53 de 11/09 uma
 * parcela de 10/09 é "1 dia", nunca "2". null = sem data.
 */
export function daysLateOn(ymd: string | null, todayKey: string): number | null {
  if (!ymd) return null
  const venc = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`)
  const hoje = Date.parse(`${todayKey}T00:00:00Z`)
  if (Number.isNaN(venc) || Number.isNaN(hoje)) return null
  return Math.round((hoje - venc) / 86_400_000)
}

/**
 * O motivo do freio, como o diálogo mostra (em âmbar, antes de "Enviar mesmo
 * assim"). Diferente de `holdRefusal`, que é a recusa de um envio já feito.
 */
export function manualHoldReason(
  hold: DebtorHold | null,
  st: { pausedReason?: string | null; snoozeUntil?: string | null; snoozeReason?: string | null },
): string | null {
  if (!hold) return null
  const motivo = (m: string | null | undefined) => (m && m.trim() ? ` (${m.trim()})` : '')
  if (hold === 'paused') return `Este cliente está marcado como "não cobrar"${motivo(st.pausedReason)}.`
  if (hold === 'snoozed') {
    const ms = st.snoozeUntil ? Date.parse(st.snoozeUntil) : Number.NaN
    const ate = Number.isNaN(ms)
      ? ''
      : ` até ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(ms))}`
    return `Este cliente prometeu pagar${ate}${motivo(st.snoozeReason)} — a régua está dormindo nele.`
  }
  return 'Este cliente chegou ao limite de cobranças sem resposta da régua.'
}

/** "sexta-feira à tarde" — a cor local que a IA recebe (mesma regra da régua). */
export function momentLabel(hour: number, weekday: number): string {
  const dias = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
  if (weekday < 0 || weekday > 6) return ''
  return `${dias[weekday]} ${hour < 12 ? 'de manhã' : hour < 18 ? 'à tarde' : 'à noite'}`
}

export interface ManualCollectRequestArgs {
  accountId: string
  contactId: string
  conversationId: string
  channelId: string
  byUserId: string
  /** Nº do toque que este envio É (touchCount anterior + 1). */
  touch: number
  /** Texto SEM assinatura — é o que a IA recebe como "não repita". */
  text: string
  lines: string[]
  links: string[]
  /** ISO de agora. */
  now: string
  /** Vencimento (dd/mm/aaaa) e descrição da parcela — variáveis do template. */
  dueDateText?: string
  descriptionText?: string
  /** Parcelas (asaasId + conta) — a faixa "Economia no Asaas" quebra por conta. */
  refs?: { asaasId: string; connectionId: string }[]
}

export interface ManualCollectRequestValues {
  accountId: string
  contactId: string
  conversationId: string
  actionType: 'collect_charges'
  payload: {
    kind: typeof MANUAL_COLLECT_KIND
    sentBy: 'wallet'
    channelId: string
    byUserId: string
    touch: number
    lines: string[]
    links: string[]
    delivery: 'whatsapp'
  }
  suggestedText: string
  reason: string
  decision: 'suggest'
  policy: string
  status: 'sent'
  executedAt: string
  resolvedAt: string
  resolvedBy: string
  result: { conversationId: string; sentVia: ['whatsapp']; label: 'WhatsApp' }
}

/**
 * O pedido em agent_action_requests já nascendo ENVIADO (precedente:
 * thanks.ts). É o que faz o envio à mão aparecer no painel "Envios da régua",
 * consumir o teto do dia e reiniciar a cadência do sender — de propósito: o
 * anti-ban é por linha, não por quem apertou. Status 'sent' não colide com o
 * índice único de pendentes (ele só vale para status='pending').
 */
export function manualCollectRequestValues(a: ManualCollectRequestArgs): ManualCollectRequestValues {
  return {
    accountId: a.accountId,
    contactId: a.contactId,
    conversationId: a.conversationId,
    actionType: 'collect_charges',
    payload: {
      kind: MANUAL_COLLECT_KIND,
      ...(a.refs?.length ? paymentRefsPayload(a.refs) : {}),
      sentBy: 'wallet',
      channelId: a.channelId,
      byUserId: a.byUserId,
      touch: a.touch,
      lines: a.lines,
      links: a.links,
      ...(a.dueDateText ? { dueDateText: a.dueDateText } : {}),
      ...(a.descriptionText ? { descriptionText: a.descriptionText } : {}),
      delivery: 'whatsapp',
    },
    suggestedText: a.text,
    reason: 'Cobrança enviada à mão pela carteira.',
    decision: 'suggest',
    policy: 'manual · botão Cobrar pelo WhatsApp',
    status: 'sent',
    executedAt: a.now,
    resolvedAt: a.now,
    resolvedBy: a.byUserId,
    result: { conversationId: a.conversationId, sentVia: ['whatsapp'], label: 'WhatsApp' },
  }
}

/**
 * Motivo gravado no pedido automático que ficou na fila (pending/queued)
 * para o mesmo contato: sem expirar, o sender mandava a MESMA cobrança
 * minutos depois do envio à mão.
 */
export function manualCollectExpireReason(senderName: string | null | undefined): string {
  const nome = (senderName ?? '').trim() || 'uma pessoa da equipe'
  return `Cobrado à mão por ${nome}; o pedido automático foi cancelado.`
}

/**
 * Que pedidos pendentes do contato o envio à mão expira: só a COBRANÇA da
 * régua (sem `kind`) ou outra manual. Lembrete a vencer, aviso de cobrança
 * nova e aviso do dia do vencimento são entrega de link de outra parcela —
 * expirar o aviso perderia o link para sempre (ele é marcado "avisado" em
 * qualquer status). A lista é `NOTICE_KINDS` (rules.ts).
 */
export function manualCollectExpiresKind(kind: unknown): boolean {
  return !NOTICE_KINDS.has(kind)
}

/** Toast de sucesso: "Cobrança enviada pelo Cobranças (seu número) · contou como toque Nº 2". */
export function manualCollectSuccessMessage(channelLabel: string, touch: number): string {
  return `Cobrança enviada pelo ${channelLabel} · contou como toque Nº ${touch}`
}

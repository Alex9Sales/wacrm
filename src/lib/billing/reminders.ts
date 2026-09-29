// ============================================================
// 🔔 Lembrete automático da mensalidade (25/09, pedido do Alex).
//
// Até agora o lembrete existia só no BOTÃO do /admin: alguém tinha que
// lembrar de clicar, cliente por cliente. Aqui ele vira rotina — cinco dias
// antes, no dia e depois do vencimento.
//
// Três cuidados que valem mais que o código:
//   • UMA mensagem por cliente por degrau. O carimbo fica em
//     organization_billing.notes? Não: numa coluna própria, senão um deploy
//     no meio do dia reenviaria tudo.
//   • Só em horário decente e em dia útil — cobrança às 23h queima a marca.
//   • Cliente sem telefone, cancelado ou excluído fica de fora, sem barulho.
//
// Quem envia é o canal da Fluxia (PLATFORM_BILLING_CHANNEL_ID). Sendo canal
// oficial da Meta, fora da janela de 24h só sai com TEMPLATE aprovado — por
// isso o texto livre é o plano B, não o principal.
// ============================================================

import { localParts } from '@/lib/settings/business-hours'

/** Os degraus, em dias relativos ao vencimento (negativo = antes). */
export const REMINDER_STEPS = [-5, 0, 3] as const
export type ReminderStep = (typeof REMINDER_STEPS)[number]

/** Janela de envio, no fuso da operação. */
export const SEND_FROM_HOUR = 9
export const SEND_TO_HOUR = 18

export interface ReminderCandidate {
  orgId: string
  name: string
  billingPhone: string | null
  plan: string | null
  monthlyValue: number | null
  dueAt: string | null
  status: string
  /** Degraus já enviados neste vencimento (ex.: [-5]). */
  sentSteps: number[]
}

/** Dias inteiros entre hoje e o vencimento (negativo = já venceu). */
export function daysUntil(dueAt: string, now: Date): number {
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return NaN
  const a = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate())
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.round((a - b) / 86_400_000)
}

/**
 * O degrau que cabe HOJE para este cliente, ou null.
 *
 * Um degrau vencido não "acumula": se o lembrete de 5 dias antes não saiu (a
 * conta foi cadastrada ontem, o worker estava fora), ele não dispara depois
 * junto com o do dia — o cliente receberia duas mensagens seguidas.
 */
export function dueStep(c: ReminderCandidate, now: Date): ReminderStep | null {
  if (!c.dueAt || !c.billingPhone?.trim()) return null
  if (c.status !== 'active') return null
  const dias = daysUntil(c.dueAt, now)
  if (Number.isNaN(dias)) return null

  // -5 → faltam exatamente 5 dias. 0 → vence hoje. 3 → venceu há 3 dias.
  const step: ReminderStep | null =
    dias === 5 ? -5 : dias === 0 ? 0 : dias === -3 ? 3 : null
  if (step === null) return null
  return c.sentSteps.includes(step) ? null : step
}

/** Fuso em que a janela de envio é lida. A operação é brasileira. */
export const SEND_TIMEZONE = 'America/Sao_Paulo'

/**
 * Dá pra enviar agora? Horário comercial, segunda a sexta — NO FUSO DA
 * OPERAÇÃO.
 *
 * ⚠️ 29/09: isto usava `now.getHours()`, que devolve a hora do processo. O
 * worker roda em UTC (TZ vazio no container), então "9h às 18h" era 9h–18h UTC
 * = **6h às 15h em Brasília**: a Appia foi avisada às 6h da manhã, e quem
 * vencia à tarde não recebia nada. O mesmo valia para o fim de semana — 21h de
 * sábado em SP já é domingo em UTC.
 *
 * O comentário do topo deste arquivo diz "cobrança às 23h queima a marca". A
 * intenção estava certa; faltava o fuso.
 */
export function canSendNow(now: Date): boolean {
  let day: number
  let minutes: number
  try {
    ;({ day, minutes } = localParts(now, SEND_TIMEZONE))
  } catch {
    return false // fuso inválido: não envia, em vez de enviar na hora errada
  }
  if (day === 0 || day === 6) return false
  const h = Math.floor(minutes / 60)
  return h >= SEND_FROM_HOUR && h < SEND_TO_HOUR
}

/**
 * Valor em reais com espaço NORMAL.
 *
 * ⚠️ `toLocaleString('pt-BR')` devolve "R$\u00A01.298,50" com espaço
 * não-quebrável (código 160, não 32). No WhatsApp isso passa despercebido
 * até alguém tentar procurar o valor no texto — ou o app quebrar a linha em
 * lugar estranho. Troca por espaço comum.
 */
/** Valor em reais para o parâmetro do template (a Meta recusa quebra de linha). */
export const brlSimples = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00A0/g, ' ')

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/\u00A0/g, ' ')

/** Data no formato que o cliente lê. */
export function diaBr(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * O texto de cada degrau. Curto, sem drama e sem ameaça: quem está em dia
 * recebe um aviso, não uma cobrança.
 */
export function reminderText(c: ReminderCandidate, step: ReminderStep): string {
  const valor = c.monthlyValue ? ` de ${brl(c.monthlyValue)}` : ''
  const dia = c.dueAt ? diaBr(c.dueAt) : ''
  if (step === -5) {
    return (
      `Olá! Aqui é da Fluxia 😊 Passando só pra avisar que a sua mensalidade${valor} ` +
      `vence dia ${dia}. O boleto já está disponível — qualquer coisa é só me chamar por aqui.`
    )
  }
  if (step === 0) {
    return (
      `Olá! Aqui é da Fluxia 😊 A sua mensalidade${valor} vence hoje. ` +
      `Se já pagou, pode desconsiderar — e se precisar da segunda via, me avisa que eu mando.`
    )
  }
  return (
    `Olá! Aqui é da Fluxia. A mensalidade${valor} que venceu dia ${dia} ainda está em aberto. ` +
    `Consegue dar uma olhada? Se já pagou ou precisar de outra data, me chama aqui que a gente resolve.`
  )
}

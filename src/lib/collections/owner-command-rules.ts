// ============================================================
// 🧾 Comando do dono pelo WhatsApp — a parte pura (item 6 da auditoria).
//
// "Cria uma cobrança de 150 pro João vencendo dia 10" mandado pelo DONO da
// conta, do WhatsApp dele, para o número da empresa. O modelo extrai os
// campos; AQUI se decide se é comando, se é confirmação, e os valores finais
// (com os mesmos parseValue/parseDueDate da emissão pela IA). Dinheiro do
// cliente do cliente: nada sai sem o SIM dele.
// ============================================================

import { parseDueDate, parseValue } from './emit-rules'

/** Parece um pedido de cobrança? (verbo + palavra de cobrança; valor vem depois). */
/**
 * Junta a "rajada" do dono: as últimas mensagens dele (só do cliente da
 * conversa) até a última resposta do CRM, dentro da janela, em ordem
 * cronológica. Caso 08/09 (Alex): "Cria uma cobrança" / "Para Danyela Souza" /
 * "Valor de 5 reais" / "Vencimento amanhã" / "Pix" em CINCO balões — olhando só
 * o último ("Pix") não parece pedido nenhum e o agente de vendas assumia.
 * `rowsNewestFirst` = mensagens não-internas, da mais nova pra mais velha.
 */
export function joinCustomerBurst(
  rowsNewestFirst: Array<{ senderType: string; text: string | null; createdAt: string | Date | null }>,
  opts: { windowMs?: number; max?: number } = {},
): string {
  const windowMs = opts.windowMs ?? 10 * 60 * 1000
  const max = opts.max ?? 8
  const newest = rowsNewestFirst[0]
  if (!newest || newest.senderType !== 'customer') return ''
  const newestAt = newest.createdAt ? new Date(newest.createdAt).getTime() : Date.now()
  const at = (v: string | Date | null) => (v ? new Date(v).getTime() : newestAt)
  const parts: string[] = []
  for (const r of rowsNewestFirst) {
    if (r.senderType !== 'customer') break
    if (newestAt - at(r.createdAt) > windowMs) break
    const t = (r.text ?? '').trim()
    if (t) parts.push(t)
    if (parts.length >= max) break
  }
  return parts.reverse().join('\n')
}

export function looksLikeChargeCommand(text: string): boolean {
  const t = text.toLowerCase()
  const money = /cobran[cç]a|cobrar|boleto|pix|link de pagamento|fatura/.test(t)
  const verb = /\b(cria|criar|gera|gerar|manda|mandar|faz|fazer|emite|emitir|envia|enviar|cobra)\b/.test(t)
  return money && verb
}

// Fim de palavra que respeita acento: o \b do JS é ASCII e "simão" passaria como "sim".
const WORD_END = '(?![\\p{L}\\p{N}])'
const CONFIRM_RE = new RegExp(`^(sim|s|ok|okay|confirma|confirmo|confirmado|pode|pode sim|isso|isso mesmo|manda|vai|bora|certo|correto)${WORD_END}`, 'iu')
const CANCEL_RE = new RegExp(`^(n[aã]o|nao|cancela|cancelar|deixa|esquece|para|errado)${WORD_END}`, 'iu')

export function looksLikeConfirmation(text: string): boolean {
  const t = text.trim()
  return CONFIRM_RE.test(t) || /^(👍|✅)/u.test(t)
}

export function looksLikeCancel(text: string): boolean {
  const t = text.trim()
  return CANCEL_RE.test(t) || /^❌/u.test(t)
}

/** "2", "o 2", "segundo" → índice 1. null quando não é escolha. */
export function pickCandidateIndex(text: string, count: number): number | null {
  const t = text.trim().toLowerCase()
  const m = /^(?:o|a|opção|opcao|número|numero|n[º°]?)?\s*(\d{1,2})\s*[.)]?$/.exec(t)
  if (m) {
    const n = Number(m[1])
    return n >= 1 && n <= count ? n - 1 : null
  }
  const words = ['primeiro', 'segundo', 'terceiro', 'quarto', 'quinto']
  const w = words.findIndex((x) => t.startsWith(x) || t.startsWith('o ' + x) || t.startsWith('a ' + x))
  return w >= 0 && w < count ? w : null
}

export interface RawParsedCommand {
  customer?: string | null
  phone?: string | null
  value?: string | number | null
  dueDate?: string | null
  description?: string | null
  /** "em 3x", "3 vezes", "parcelado em 4" → número de parcelas. */
  installments?: string | number | null
}

export interface ParsedCommand {
  customerQuery: string | null
  value: number | null
  dueDate: string | null
  description: string
  /** O dono não disse vencimento → entrou o padrão de 3 dias (a proposta avisa). */
  dueDefaulted: boolean
  /** Parcelas (2–60) ou null = à vista. */
  installments: number | null
}

export const MAX_CHARGE_INSTALLMENTS = 60

/** Normaliza o que o modelo extraiu: valor e data pelas regras da emissão; vencimento padrão +3 dias. */
export function normalizeParsedCommand(raw: RawParsedCommand, today: Date = new Date()): ParsedCommand {
  const query = (raw.phone && String(raw.phone).replace(/\D/g, '').length >= 8 ? String(raw.phone) : raw.customer ? String(raw.customer) : '').trim() || null
  const value = raw.value == null ? null : parseValue(String(raw.value))
  const dueDefaulted = !raw.dueDate
  const due = raw.dueDate ? parseDueDate(String(raw.dueDate), today) : parseDueDate('+3', today)
  const description = (raw.description ?? '').toString().trim() || 'Cobrança'
  let installments: number | null = null
  if (raw.installments != null && raw.installments !== '') {
    const n = Math.trunc(Number(String(raw.installments).replace(/\D/g, '')))
    if (Number.isFinite(n) && n >= 2 && n <= MAX_CHARGE_INSTALLMENTS) installments = n
  }
  return { customerQuery: query, value, dueDate: due, description, dueDefaulted, installments }
}

/** "em 3x (R$ 50,00 cada)" — só quando parcelado. */
export function installmentsLabel(value: number, installments: number | null | undefined): string {
  if (!installments || installments < 2) return ''
  return ` em ${installments}x (${brl(value / installments)} cada)`
}

/** Aviso que acompanha a proposta quando o vencimento foi o padrão. */
export const DUE_DEFAULTED_NOTE = '(Você não disse o vencimento: coloquei 3 dias. Quer outra data? Diga antes do SIM, ex.: "vence amanhã".)'

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/')

export function formatProposal(p: { name: string | null; phone: string; value: number; dueDate: string; description: string; installments?: number | null }): string {
  return `Confirma? Cobrar ${brl(p.value)}${installmentsLabel(p.value, p.installments)} de ${p.name?.trim() || p.phone} (${p.phone}), vencendo ${br(p.dueDate)}, "${p.description}". Responda SIM para gerar e mandar o link, ou NÃO para cancelar.`
}

export function formatCandidates(cands: { name: string | null; phone: string }[]): string {
  const lines = cands.map((c, i) => `${i + 1}) ${c.name?.trim() || 'Sem nome'} · ${c.phone}`)
  return `Achei mais de um. Qual é?\n${lines.join('\n')}\nResponda o número.`
}

export function formatDone(p: { name: string | null; phone: string; value: number; dueDate: string }, link: string, sentVia: string | null): string {
  return `Pronto ✅ Cobrança de ${brl(p.value)} para ${p.name?.trim() || p.phone}, vence ${br(p.dueDate)}.${sentVia ? ` Link enviado por ${sentVia}.` : ' Não consegui mandar o link — segue para você repassar:'}\n${link}`
}

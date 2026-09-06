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
}

export interface ParsedCommand {
  customerQuery: string | null
  value: number | null
  dueDate: string | null
  description: string
}

/** Normaliza o que o modelo extraiu: valor e data pelas regras da emissão; vencimento padrão +3 dias. */
export function normalizeParsedCommand(raw: RawParsedCommand, today: Date = new Date()): ParsedCommand {
  const query = (raw.phone && String(raw.phone).replace(/\D/g, '').length >= 8 ? String(raw.phone) : raw.customer ? String(raw.customer) : '').trim() || null
  const value = raw.value == null ? null : parseValue(String(raw.value))
  const due = raw.dueDate ? parseDueDate(String(raw.dueDate), today) : parseDueDate('+3', today)
  const description = (raw.description ?? '').toString().trim() || 'Cobrança'
  return { customerQuery: query, value, dueDate: due, description }
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/')

export function formatProposal(p: { name: string | null; phone: string; value: number; dueDate: string; description: string }): string {
  return `Confirma? Cobrar ${brl(p.value)} de ${p.name?.trim() || p.phone} (${p.phone}), vencendo ${br(p.dueDate)}, "${p.description}". Responda SIM para gerar e mandar o link, ou NÃO para cancelar.`
}

export function formatCandidates(cands: { name: string | null; phone: string }[]): string {
  const lines = cands.map((c, i) => `${i + 1}) ${c.name?.trim() || 'Sem nome'} · ${c.phone}`)
  return `Achei mais de um. Qual é?\n${lines.join('\n')}\nResponda o número.`
}

export function formatDone(p: { name: string | null; phone: string; value: number; dueDate: string }, link: string, sentVia: string | null): string {
  return `Pronto ✅ Cobrança de ${brl(p.value)} para ${p.name?.trim() || p.phone}, vence ${br(p.dueDate)}.${sentVia ? ` Link enviado por ${sentVia}.` : ' Não consegui mandar o link — segue para você repassar:'}\n${link}`
}

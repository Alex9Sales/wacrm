// ============================================================
// 🧾 Emissão de cobrança pela IA — REGRAS (puras, testáveis, client-safe).
//
// `criar_cobranca` (05/09, pedido do João/GoLink): no meio do atendimento, o
// cliente confirma produto e valor, a IA cria a cobrança no Asaas da conta e
// manda o link. É dinheiro do cliente do nosso cliente, então as travas são
// determinísticas e ficam AQUI, não no prompt: a IA propõe valor, vencimento
// e descrição; este módulo decide se pode.
// ============================================================

export interface EmitGuard {
  /** Acima disso a IA NÃO emite sozinha — vira aviso pra uma pessoa. */
  maxValue: number
  /** Vencimento no máximo N dias à frente. */
  maxDueDays: number
}

export const EMIT_DEFAULTS: EmitGuard = { maxValue: 500, maxDueDays: 60 }

/** "125", "125,00", "R$ 1.250,50", "1250.5" → número. Inválido → null. */
export function parseValue(raw: string | null | undefined): number | null {
  if (!raw) return null
  // "-10" não é "10 com lixo na frente": é negativo, e cobrança negativa não existe.
  if (/^\s*-/.test(raw)) return null
  let s = raw.replace(/[^\d,.]/g, '')
  if (!s) return null
  // Formato brasileiro (vírgula decimal) vs. ponto decimal.
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100) / 100
}

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Vencimento: "2026-09-30", "30/09", "30/09/2026", "+7" ou "7" (dias).
 * Devolve YYYY-MM-DD ou null. Não valida janela — isso é do validateEmit.
 */
export function parseDueDate(raw: string | null | undefined, today: Date = new Date()): string | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  let m = /^\+?(\d{1,3})$/.exec(s)
  if (m) {
    const d = new Date(base)
    d.setDate(d.getDate() + Number(m[1]))
    return ymd(d)
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return d.getMonth() === Number(m[2]) - 1 ? ymd(d) : null
  }
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s)
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getFullYear()
    let d = new Date(y, Number(m[2]) - 1, Number(m[1]))
    if (d.getMonth() !== Number(m[2]) - 1) return null
    // "30/01" dito em dezembro é janeiro do ano que vem, não do passado.
    if (!m[3] && d < base) d = new Date(y + 1, Number(m[2]) - 1, Number(m[1]))
    return ymd(d)
  }
  return null
}

export interface EmitRequest {
  value: number | null
  dueDate: string | null
  description: string
}

export type EmitVerdict = { ok: true } | { ok: false; reason: string }

/** Pode emitir? Sempre explica o não — o motivo volta pra IA e pra nota. */
export function validateEmit(req: EmitRequest, guard: EmitGuard, today: Date = new Date()): EmitVerdict {
  if (req.value == null) return { ok: false, reason: 'valor inválido' }
  if (req.value > guard.maxValue) {
    return { ok: false, reason: `valor acima do máximo que a IA pode emitir sozinha (R$ ${guard.maxValue.toFixed(2).replace('.', ',')})` }
  }
  if (!req.dueDate) return { ok: false, reason: 'vencimento inválido' }
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const due = new Date(`${req.dueDate}T00:00:00`)
  if (due < base) return { ok: false, reason: 'vencimento no passado' }
  const dias = Math.round((due.getTime() - base.getTime()) / 86_400_000)
  if (dias > guard.maxDueDays) return { ok: false, reason: `vencimento a mais de ${guard.maxDueDays} dias` }
  if (!req.description.trim() || req.description.trim().length < 3) return { ok: false, reason: 'descrição vazia' }
  return { ok: true }
}

export interface RecentCharge {
  value: number
  createdAt: string
  open: boolean
  invoiceUrl: string | null
}

/**
 * Já existe cobrança igual, aberta, criada há pouco nesta conversa? Então
 * NÃO cria outra — reaproveita o link. É a mesma lição do pedido triplicado
 * (Wellington, 04/09): o cliente confirma de novo, manda comprovante, muda
 * de ideia — e a IA re-chama a ferramenta.
 */
export function findDuplicateCharge(recent: RecentCharge[], value: number, now: Date = new Date(), windowHours = 6): RecentCharge | null {
  const cutoff = now.getTime() - windowHours * 3_600_000
  return (
    recent.find((r) => r.open && Math.abs(r.value - value) < 0.005 && new Date(r.createdAt).getTime() >= cutoff) ?? null
  )
}

/**
 * Mensagem que acompanha o link quando a cobrança é gerada à mão (Cobranças →
 * Nova cobrança) e o operador pede para enviar. Curta e sem cobrança dura: é
 * um link pedido no atendimento, não uma régua.
 */
export function manualChargeMessage(firstName: string | null, value: number, dueDate: string, description: string, url: string): string {
  const brl = value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  const due = dueDate.slice(0, 10).split('-').reverse().join('/')
  const oi = firstName ? `Oi, ${firstName}! ` : 'Oi! '
  const sobre = description.trim() ? ` (${description.trim()})` : ''
  return `${oi}Segue o link para pagamento de ${brl}${sobre}, com vencimento em ${due}:\n${url}\n\nQualquer dúvida é só responder por aqui.`
}

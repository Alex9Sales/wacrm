// ============================================================
// 🧾 Régua de cobrança — REGRAS (puras, testáveis, client-safe).
//
// A régua é o coração da Fase 2: a cada ciclo o sistema reconsulta o que está
// em aberto NAQUELE instante e monta UMA mensagem por devedor, com todas as
// parcelas dele juntas. É isso que faz três parcelas virarem duas quando o
// cliente paga uma.
//
// Tudo aqui é configuração por conta. Nenhuma regra de negócio de nenhum
// cliente vira condição no código — é a regra que separa produto de
// consultoria, e é ela que faz o segundo cliente não exigir reescrita.
// ============================================================

export interface CollectionsSettings {
  /** Nasce DESLIGADA: cobrar alguém nunca é um padrão, é uma decisão. */
  enabled: boolean
  /** Dias entre um toque e o próximo no mesmo devedor. */
  intervalDays: number
  /** Só cobra quem passou disso. 0 = cobra no dia seguinte ao vencimento. */
  minDaysOverdue: number
  /** Teto de devedores cobrados por dia (anti-ban e sanidade). */
  dailyCap: number
  /** Janela de envio, no fuso da conta. */
  startHour: number
  endHour: number
  /** Não cobra sábado e domingo. */
  weekdaysOnly: boolean
  /** auto = usa o canal que o contato tem; senão força um. */
  channel: 'auto' | 'whatsapp' | 'email'
  /** Status do Asaas que contam como vencido nesta conta. */
  overdueStatuses: string[]
  /**
   * Depois de N toques sem o devedor responder, a régua PARA nele e avisa o
   * time. Cobrar para sempre a cada 3 dias é o caminho mais curto para o
   * número ser denunciado — e para o cliente perder o cliente dele.
   */
  maxTouches: number
  /** Instrução de tom, no vocabulário do negócio (vai para a IA). */
  tone: string
}

export const COLLECTIONS_DEFAULTS: CollectionsSettings = {
  enabled: false,
  intervalDays: 3,
  minDaysOverdue: 1,
  dailyCap: 40,
  startHour: 9,
  endHour: 18,
  weekdaysOnly: true,
  channel: 'auto',
  overdueStatuses: ['OVERDUE'],
  maxTouches: 8,
  tone: '',
}

export function normalizeSettings(raw: unknown): CollectionsSettings {
  const r = (raw ?? {}) as Partial<CollectionsSettings>
  const int = (v: unknown, def: number, min: number, max: number) => {
    const n = typeof v === 'number' ? Math.round(v) : Number.NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
  }
  const statuses = Array.isArray(r.overdueStatuses)
    ? r.overdueStatuses.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : []
  return {
    enabled: r.enabled === true,
    intervalDays: int(r.intervalDays, 3, 1, 60),
    minDaysOverdue: int(r.minDaysOverdue, 1, 0, 365),
    dailyCap: int(r.dailyCap, 40, 1, 500),
    startHour: int(r.startHour, 9, 0, 23),
    endHour: int(r.endHour, 18, 1, 24),
    weekdaysOnly: r.weekdaysOnly !== false,
    channel: r.channel === 'whatsapp' || r.channel === 'email' ? r.channel : 'auto',
    overdueStatuses: statuses.length ? statuses : [...COLLECTIONS_DEFAULTS.overdueStatuses],
    maxTouches: int(r.maxTouches, 8, 1, 50),
    tone: typeof r.tone === 'string' ? r.tone.slice(0, 600) : '',
  }
}

/**
 * Os status que fazem sentido numa régua, com o nome que o cliente entende.
 * Os demais do Asaas (RECEIVED, CONFIRMED…) já estão pagos — não se cobra.
 */
export const CHARGEABLE_STATUSES: { value: string; label: string; hint: string }[] = [
  { value: 'OVERDUE', label: 'Vencida', hint: 'Passou do vencimento e não foi paga. É o padrão.' },
  {
    value: 'PENDING',
    label: 'A vencer',
    hint: 'Ainda não venceu. Ligue só se você quer LEMBRAR antes do vencimento — não é cobrança de inadimplente.',
  },
]

// ------------------------------------------------------------- elegibilidade

/** Por que um devedor NÃO foi cobrado agora — sempre explicável, nunca mudo. */
export type SkipReason =
  | 'ok'
  | 'no_contact'
  | 'opted_out'
  | 'not_due'
  | 'snoozed'
  | 'paused'
  | 'too_soon'
  | 'max_touches'

export const SKIP_LABEL: Record<SkipReason, string> = {
  ok: 'Pronto para cobrar',
  no_contact: 'A cobrança não casou com nenhum contato do CRM',
  opted_out: 'O contato pediu para não receber mensagens',
  not_due: 'Ainda não passou do prazo mínimo de atraso',
  snoozed: 'O cliente prometeu pagar em uma data que ainda não chegou',
  paused: 'A cobrança deste devedor está pausada',
  too_soon: 'O último toque foi há pouco tempo',
  max_touches: 'Atingiu o limite de toques sem resposta — precisa de uma pessoa',
}

export interface TouchState {
  lastTouchAt: string | null
  touchCount: number
  snoozeUntil: string | null
  paused: boolean
}

export interface EligibleInput {
  contactId: string | null
  optedOut: boolean
  /** Maior atraso entre as parcelas em aberto do devedor. */
  maxDaysLate: number | null
  state: TouchState | null
}

export function eligibility(input: EligibleInput, s: CollectionsSettings, now = new Date()): SkipReason {
  if (!input.contactId) return 'no_contact'
  if (input.optedOut) return 'opted_out'

  const st = input.state
  if (st?.paused) return 'paused'
  if (st && st.touchCount >= s.maxTouches) return 'max_touches'

  if (st?.snoozeUntil) {
    const until = new Date(st.snoozeUntil)
    if (!Number.isNaN(until.getTime()) && until.getTime() > now.getTime()) return 'snoozed'
  }

  if (input.maxDaysLate == null || input.maxDaysLate < s.minDaysOverdue) return 'not_due'

  if (st?.lastTouchAt) {
    const last = new Date(st.lastTouchAt)
    if (!Number.isNaN(last.getTime())) {
      const days = (now.getTime() - last.getTime()) / 86_400_000
      if (days < s.intervalDays) return 'too_soon'
    }
  }

  return 'ok'
}

/**
 * A janela é avaliada com a hora JÁ convertida para o fuso da conta —
 * quem converte é quem chama, para esta função continuar pura.
 */
export function withinWindow(localHour: number, localWeekday: number, s: CollectionsSettings): boolean {
  if (s.weekdaysOnly && (localWeekday === 0 || localWeekday === 6)) return false
  return localHour >= s.startHour && localHour < s.endHour
}

// ------------------------------------------------------------ texto da dívida

export interface ChargeLine {
  value: number
  dueDate: string | null
  daysLate: number | null
  connectionLabel: string
  invoiceUrl: string | null
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : 'sem data')

/**
 * O resumo da dívida que vai NA mensagem. Fatos apenas — a IA escreve o texto
 * ao redor, mas os números vêm daqui prontos, para ela nunca ter que somar
 * (é o tipo de coisa que um modelo erra e ninguém percebe).
 *
 * `multiAccount` marca de qual conta é cada parcela, e só aparece quando há
 * mais de uma conta envolvida — no caso normal ninguém precisa ver isso.
 */
export function formatDebtSummary(charges: ChargeLine[]): { total: number; lines: string[]; links: string[] } {
  const multiAccount = new Set(charges.map((c) => c.connectionLabel)).size > 1
  const ordered = [...charges].sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1))

  const lines = ordered.map((c) => {
    const atraso = c.daysLate == null ? '' : c.daysLate > 0 ? ` (${c.daysLate} ${c.daysLate === 1 ? 'dia' : 'dias'} de atraso)` : ''
    const conta = multiAccount ? ` — ${c.connectionLabel}` : ''
    return `${brl(c.value)} · venceu em ${br(c.dueDate)}${atraso}${conta}`
  })

  const links = [...new Set(ordered.map((c) => c.invoiceUrl).filter((u): u is string => !!u))]
  return { total: ordered.reduce((sum, c) => sum + c.value, 0), lines, links }
}

/**
 * Texto de segurança usado quando a IA não está disponível. Seco de
 * propósito: é melhor uma mensagem correta e sem graça do que nenhuma — mas
 * ela nunca sai sozinha, porque a régua começa passando pela aprovação.
 */
export function fallbackMessage(firstName: string | null, summary: ReturnType<typeof formatDebtSummary>, touch: number): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const abre =
    touch === 0
      ? `${oi} Passando para lembrar de um valor em aberto por aqui:`
      : `${oi} Voltando no valor que ficou em aberto:`
  const corpo = summary.lines.map((l) => `• ${l}`).join('\n')
  const total = summary.lines.length > 1 ? `\n\nTotal: ${brl(summary.total)}` : ''
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${abre}\n\n${corpo}${total}${link}\n\nSe já pagou ou quiser combinar uma data, é só me dizer por aqui.`
}

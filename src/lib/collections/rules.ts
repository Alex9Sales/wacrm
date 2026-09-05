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

export type DeliveryChannel = 'auto' | 'whatsapp' | 'email' | 'both'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  /**
   * Por onde cobrar. auto = WhatsApp quando o contato tem telefone, senão
   * e-mail; both = os dois no mesmo toque (boleto no e-mail, lembrete no zap).
   */
  channel: DeliveryChannel
  /**
   * Número (canal de WhatsApp) que ENVIA a cobrança quando o devedor ainda não
   * tem conversa no CRM. null = automático: o único número conectado da conta;
   * com mais de um, a régua pede para escolher em vez de chutar.
   */
  channelId: string | null
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
  /**
   * Teto para a IA EMITIR cobrança sozinha (criar_cobranca). Acima disso ela
   * não cria — avisa uma pessoa. É dinheiro do cliente do cliente: o limite
   * é configuração, não constante.
   */
  emitMaxValue: number
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
  channelId: null,
  overdueStatuses: ['OVERDUE'],
  maxTouches: 8,
  tone: '',
  emitMaxValue: 500,
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
    channel: r.channel === 'whatsapp' || r.channel === 'email' || r.channel === 'both' ? r.channel : 'auto',
    channelId: typeof r.channelId === 'string' && UUID_RE.test(r.channelId) ? r.channelId : null,
    overdueStatuses: statuses.length ? statuses : [...COLLECTIONS_DEFAULTS.overdueStatuses],
    maxTouches: int(r.maxTouches, 8, 1, 50),
    tone: typeof r.tone === 'string' ? r.tone.slice(0, 600) : '',
    emitMaxValue: (() => {
      const n = typeof r.emitMaxValue === 'number' ? r.emitMaxValue : Number.NaN
      return Number.isFinite(n) ? Math.min(100_000, Math.max(1, Math.round(n * 100) / 100)) : 500
    })(),
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
  | 'no_channel'
  | 'snoozed'
  | 'paused'
  | 'too_soon'
  | 'max_touches'

export const SKIP_LABEL: Record<SkipReason, string> = {
  ok: 'Pronto para cobrar',
  no_contact: 'A cobrança não casou com nenhum contato do CRM',
  opted_out: 'O contato pediu para não receber mensagens',
  not_due: 'Ainda não passou do prazo mínimo de atraso',
  no_channel: 'Sem como alcançar: falta telefone/e-mail no contato ou canal na conta',
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
 *
 * Mesmo sendo o texto de segurança, ele VARIA (05/09): abertura e fechamento
 * sorteados pela semente — dois devedores no mesmo dia não recebem a mesma
 * frase. Semente 0 é o texto original. Valores e link nunca mudam.
 */
export function fallbackMessage(firstName: string | null, summary: ReturnType<typeof formatDebtSummary>, touch: number, seed = 0): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const primeiras = [
    `${oi} Passando para lembrar de um valor em aberto por aqui:`,
    `${oi} Tudo bem? Vi aqui um valor em aberto e queria te lembrar:`,
    `${oi} Dando um toque rápido: ficou um valor em aberto por aqui:`,
    `${oi} Só para lembrar, ficou pendente por aqui:`,
  ]
  const seguintes = [
    `${oi} Voltando no valor que ficou em aberto:`,
    `${oi} Passando de novo por aqui sobre o valor em aberto:`,
    `${oi} Tudo bem? Ainda consta em aberto por aqui:`,
    `${oi} Retomando o assunto do valor pendente:`,
  ]
  const fechos = [
    'Se já pagou ou quiser combinar uma data, é só me dizer por aqui.',
    'Se já tiver pago, me avisa por aqui; se preferir combinar uma data, também é só falar.',
    'Já pagou? Me conta por aqui. Se quiser combinar uma data, a gente vê junto.',
    'Qualquer dúvida, ou se quiser combinar uma data, é só responder esta mensagem.',
  ]
  const s = seed >>> 0
  const abre = (touch === 0 ? primeiras : seguintes)[s % 4]
  const corpo = summary.lines.map((l) => `• ${l}`).join('\n')
  const total = summary.lines.length > 1 ? `\n\nTotal: ${brl(summary.total)}` : ''
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${abre}\n\n${corpo}${total}${link}\n\n${fechos[(s >>> 2) % 4]}`
}

// ---------------------------------------------------------------- entrega
// Por onde a cobrança sai. Puro: quem sabe o que o contato tem e o que a conta
// tem passa os fatos; aqui só se decide — e toda recusa diz o que resolver.

export interface DeliveryFacts {
  channel: DeliveryChannel
  hasPhone: boolean
  hasEmail: boolean
  /** null = WhatsApp disponível; senão o motivo (ex.: "escolha o número em Ajustar"). */
  whatsappError: string | null
  /** null = e-mail disponível; senão o motivo (ex.: "nenhum canal de e-mail conectado"). */
  emailError: string | null
}

export type DeliveryPlan = { ok: true; whatsapp: boolean; email: boolean; label: string } | { ok: false; error: string }

const planLabel = (wa: boolean, em: boolean) => (wa && em ? 'WhatsApp e e-mail' : wa ? 'WhatsApp' : 'e-mail')

export function deliveryPlan(f: DeliveryFacts): DeliveryPlan {
  const wa = f.hasPhone && !f.whatsappError
  const em = f.hasEmail && !f.emailError
  const waWhy = !f.hasPhone ? 'o contato não tem telefone válido' : f.whatsappError!
  const emWhy = !f.hasEmail ? 'o contato não tem e-mail' : f.emailError!

  switch (f.channel) {
    case 'whatsapp':
      return wa ? { ok: true, whatsapp: true, email: false, label: 'WhatsApp' } : { ok: false, error: `A régua cobra só por WhatsApp e ${waWhy}.` }
    case 'email':
      return em ? { ok: true, whatsapp: false, email: true, label: 'e-mail' } : { ok: false, error: `A régua cobra só por e-mail e ${emWhy}.` }
    case 'both':
      if (wa || em) return { ok: true, whatsapp: wa, email: em, label: planLabel(wa, em) }
      return { ok: false, error: `Sem como alcançar: ${waWhy}; ${emWhy}.` }
    default:
      if (wa) return { ok: true, whatsapp: true, email: false, label: 'WhatsApp' }
      if (em) return { ok: true, whatsapp: false, email: true, label: 'e-mail' }
      return { ok: false, error: `Sem como alcançar: ${waWhy}; ${emWhy}.` }
  }
}

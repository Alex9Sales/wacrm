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

import { holidayName } from './holidays'

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
  /**
   * @deprecated Use `sendWeekdays`. Continua sendo lido para as contas antigas
   * e para quem ainda não abriu a tela, mas quem manda é `sendWeekdays`.
   */
  weekdaysOnly: boolean
  /**
   * Em quais dias da semana a régua pode cobrar (0=domingo … 6=sábado).
   *
   * 11/09 (Alex): "cada um tem sua forma de trabalhar — quem cobra no sábado
   * deixa de segunda a sábado, quem não cobra deixa de segunda a sexta".
   * Nunca fica vazio: lista vazia voltaria a cobrar todo dia sem ninguém pedir.
   */
  sendWeekdays: number[]
  /** Não cobra em feriado NACIONAL (ver `holidays.ts`; municipal não dá para saber). */
  skipHolidays: boolean
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
  /**
   * O CRM assume os avisos: ao sincronizar, desliga as notificações do Asaas
   * (e-mail/SMS/WhatsApp deles) de quem entra na carteira. O cliente paga por
   * envio no Asaas. Opt-in: nasce desligado.
   */
  asaasNotificationsOff: boolean
  /**
   * Agradecer quando o pagamento entra (webhook do Asaas). Só para quem a
   * régua/CRM cobrou ou cuja cobrança nasceu aqui — nunca para quem nunca
   * ouviu falar da gente por aqui. (07/09, pedido do cliente no áudio.)
   */
  thankOnPayment: boolean
  /**
   * Lembrete ANTES de vencer: N dias antes do vencimento manda um aviso leve.
   * Não é cobrança de inadimplente — é o "vence quinta, tá aí o link".
   * 0 = desligado (padrão).
   */
  reminderDaysBefore: number
  /**
   * Quando o cliente promete uma data ("pago dia 10"), além de a régua dormir,
   * mover o vencimento no Asaas para essa data (o Asaas gera novo boleto/link).
   * Só com UMA parcela em aberto — com várias, ninguém chuta qual. Nasce
   * desligado: mexer no vencimento perdoa juros/multa do Asaas, é decisão.
   */
  promiseUpdatesDueDate: boolean
  /**
   * Enviar SOZINHA, sem passar por "Precisa de você" (09/09, João/GoLink:
   * "quero automático já"). É decisão explícita do dono e ignora o portão de
   * promoção (20 decisões/14 dias) — os freios da conta continuam valendo
   * (IA pausada, "só sugestões", opt-out, IA desligada na conversa). Nasce
   * desligado.
   */
  autoSend: boolean
  /**
   * Cadência do envio automático (e do "Aprovar todas"): uma mensagem a cada
   * N minutos, dentro do horário da régua. Espaçar é o anti-ban — quarenta
   * cobranças num minuto é como o WhatsApp reconhece um robô.
   */
  sendEveryMinutes: number
  /**
   * Quem cuida das RESPOSTAS de cobrança (10/09, João/GoLink: "atribui pro
   * Leonardo do Financeiro"). Ao enviar uma cobrança, a conversa passa a ser
   * dessa pessoa — ela vê na lista dela e recebe as respostas. null = não mexe
   * na atribuição.
   */
  assigneeUserId: string | null
  /**
   * Setor em que a conversa de cobrança entra ao sair a mensagem (10/09,
   * João/GoLink: "cria um setor Asaas e tudo que o robô mandar cai lá").
   * null = não mexe no setor.
   */
  sectorId: string | null
  /**
   * Oferecer "combinar uma data" no fecho da mensagem. João (10/09): "isso dá
   * liberdade pro cliente enrolar". Desligado, a mensagem só diz que, se já
   * pagou, é só responder — a resposta continua pausando a régua.
   */
  offerDateNegotiation: boolean
  /**
   * Mostrar os VALORES (R$ de cada parcela, total, juros) na mensagem. Desligado
   * = só vencimento, dias de atraso e link (João/GoLink 10/09: "valor assusta o
   * cliente; ele paga só a mais atrasada"). Padrão ligado.
   */
  showValues: boolean
}

export const COLLECTIONS_DEFAULTS: CollectionsSettings = {
  enabled: false,
  intervalDays: 3,
  minDaysOverdue: 1,
  dailyCap: 40,
  startHour: 9,
  endHour: 18,
  weekdaysOnly: true,
  sendWeekdays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  channel: 'auto',
  channelId: null,
  overdueStatuses: ['OVERDUE'],
  maxTouches: 8,
  tone: '',
  emitMaxValue: 500,
  asaasNotificationsOff: false,
  thankOnPayment: true,
  reminderDaysBefore: 0,
  promiseUpdatesDueDate: false,
  autoSend: false,
  sendEveryMinutes: 5,
  assigneeUserId: null,
  sectorId: null,
  offerDateNegotiation: true,
  showValues: true,
}

/**
 * Dias da semana válidos, sem repetição e em ordem. Lista vazia ou lixo cai no
 * que a conta já usava (`weekdaysOnly`) — nunca em "cobra todo dia", que
 * ninguém pediu e é o erro caro aqui.
 */
export function normalizeWeekdays(raw: unknown, uteisPorPadrao = true): number[] {
  const dias = Array.isArray(raw)
    ? [...new Set(raw.map((d) => (typeof d === 'number' ? Math.round(d) : Number.NaN)).filter((d) => d >= 0 && d <= 6))].sort()
    : []
  if (dias.length) return dias
  return uteisPorPadrao ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]
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
    // Conta que ainda não escolheu os dias herda o que já valia para ela:
    // "só dias úteis" = segunda a sexta; desmarcado = a semana toda.
    sendWeekdays: normalizeWeekdays(r.sendWeekdays, r.weekdaysOnly !== false),
    skipHolidays: r.skipHolidays !== false,
    channel: r.channel === 'whatsapp' || r.channel === 'email' || r.channel === 'both' ? r.channel : 'auto',
    channelId: typeof r.channelId === 'string' && UUID_RE.test(r.channelId) ? r.channelId : null,
    overdueStatuses: statuses.length ? statuses : [...COLLECTIONS_DEFAULTS.overdueStatuses],
    maxTouches: int(r.maxTouches, 8, 1, 50),
    tone: typeof r.tone === 'string' ? r.tone.slice(0, 600) : '',
    emitMaxValue: (() => {
      const n = typeof r.emitMaxValue === 'number' ? r.emitMaxValue : Number.NaN
      return Number.isFinite(n) ? Math.min(100_000, Math.max(1, Math.round(n * 100) / 100)) : 500
    })(),
    asaasNotificationsOff: r.asaasNotificationsOff === true,
    thankOnPayment: r.thankOnPayment !== false,
    reminderDaysBefore: int(r.reminderDaysBefore, 0, 0, 15),
    promiseUpdatesDueDate: r.promiseUpdatesDueDate === true,
    autoSend: r.autoSend === true,
    sendEveryMinutes: int(r.sendEveryMinutes, 5, 1, 120),
    assigneeUserId: typeof r.assigneeUserId === 'string' && UUID_RE.test(r.assigneeUserId) ? r.assigneeUserId : null,
    sectorId: typeof r.sectorId === 'string' && UUID_RE.test(r.sectorId) ? r.sectorId : null,
    offerDateNegotiation: r.offerDateNegotiation !== false,
    showValues: r.showValues !== false,
  }
}

const NAME_STOPWORDS = new Set(['e', 'de', 'da', 'do', 'das', 'dos', '&', 'em', 'para', '-', '–', '—', '|', '/'])

/**
 * Os dígitos de uma busca de contato — ou `null` quando não dá para procurar
 * por telefone.
 *
 * 🐛 11/09 (João/GoLink): a carteira montava `phone ILIKE '%' || digitos || '%'`
 * sem essa guarda. Buscando "Center Pisos Raspadora" os dígitos davam string
 * VAZIA, o ILIKE virava `'%%'` e casava com os 286 contatos da conta — a lista
 * devolvia 20 contatos quaisquer e o certo nunca aparecia ("n acha").
 */
export function phoneSearchDigits(query: string | null | undefined): string | null {
  const d = (query ?? '').replace(/\D/g, '')
  return d.length >= 4 ? d : null
}

/** Artigo sozinho não é nome de ninguém: "A Pellogia…" tem que levar mais uma palavra. */
const NAME_ARTICLES = new Set(['a', 'o', 'as', 'os'])

/** Sufixo de razão social: ninguém quer ser chamado de "Ltda". */
const NAME_LEGAL_SUFFIX = new Set(['ltda', 'ltda.', 'lt', 'me', 'mei', 'epp', 'eireli', 'sa', 's.a', 's.a.', 'sas'])

/**
 * Como chamar o cliente na mensagem, a partir do nome COMO ESTÁ NO ASAAS
 * (decisão João/Alex 10/09: prevalece o Asaas, não o apelido do WhatsApp).
 * Sem IA não dá pra saber se é pessoa ou empresa, então a regra é de tamanho:
 * até 3 palavras vai INTEIRO ("Drogaria Faria Lima", "UTI dos Fogões",
 * "Marcenaria São José" — cortar em duas estraga todos esses); mais longo, as
 * duas primeiras ("Ultra Visão"), ou só a primeira quando a segunda é conector
 * ("João da…" → "João").
 *
 * ⚠️ 11/09: passei a regra pelos 51 clientes reais da GoLink antes de subir.
 * Forçar "duas primeiras" para atender "Dom Burguer Susan" quebrava 8 nomes
 * ("Canal da Pizza" → "Canal", "UTI dos Fogões" → "UTI"). Ficou o limite de 3.
 * Os dois consertos que a lista real pediu: ARTIGO na frente não conta como
 * palavra ("A Pellogia Corretora E…" virava "A Pellogia") e SUFIXO de razão
 * social ("Ltda", "ME") não é jeito de chamar ninguém.
 * A IA recebe o nome completo com a instrução pessoa/empresa (engine.ts).
 */
export function greetingName(name: string | null | undefined): string | null {
  const words = (name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .filter((w, i) => i === 0 || !NAME_LEGAL_SUFFIX.has(w.toLowerCase().replace(/[.,]$/, '')))
  if (!words.length) return null

  const comArtigo = NAME_ARTICLES.has(words[0].toLowerCase())
  if (words.length <= (comArtigo ? 4 : 3)) return words.join(' ')
  const keep = comArtigo ? 3 : 2
  if (NAME_STOPWORDS.has(words[keep - 1].toLowerCase())) return words.slice(0, keep - 1).join(' ')
  return words.slice(0, keep).join(' ')
}

/**
 * Cadência do envio automático: já passou N minutos desde a última mensagem
 * da régua nesta conta? Sem envio anterior, pode. Puro, pra testar.
 */
export function autoSendDue(lastSentAtMs: number | null, nowMs: number, everyMinutes: number): boolean {
  if (lastSentAtMs == null) return true
  return nowMs - lastSentAtMs >= Math.max(1, everyMinutes) * 60_000
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
  | 'duplicate_suspect'
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
  duplicate_suspect: 'Parcela idêntica em dois cadastros do Asaas — provável duplicata, resolver antes de cobrar',
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
export function withinWindow(
  localHour: number,
  localWeekday: number,
  s: CollectionsSettings,
  /** Data local `YYYY-MM-DD` — só necessária para checar feriado. */
  localDayKey?: string,
): boolean {
  if (!s.sendWeekdays.includes(localWeekday)) return false
  if (s.skipHolidays && localDayKey && holidayName(localDayKey)) return false
  return localHour >= s.startHour && localHour < s.endHour
}

/**
 * Por que a régua não vai cobrar hoje — em português, para a tela e para o log.
 * `null` quando o dia está liberado (a hora é checada à parte).
 */
export function dayBlockedReason(localWeekday: number, s: CollectionsSettings, localDayKey?: string): string | null {
  if (!s.sendWeekdays.includes(localWeekday)) return `${WEEKDAY_NAMES[localWeekday] ?? 'Hoje'} não está nos dias de cobrança`
  if (s.skipHolidays && localDayKey) {
    const feriado = holidayName(localDayKey)
    if (feriado) return `Feriado nacional (${feriado})`
  }
  return null
}

/**
 * O dia serve para AGRADECER um pagamento? Regra própria, mais solta que a da
 * cobrança (11/09, Alex: "pode deixar o agradecimento sair no sábado também").
 *
 * Agradecer não é cobrar: não incomoda, e chegar dois dias depois do pagamento
 * é pior que chegar num sábado. Então ele não se prende aos dias escolhidos
 * para a régua — só não vai em DOMINGO nem em feriado, e respeita o horário.
 */
export function thanksDayBlockedReason(localWeekday: number, s: CollectionsSettings, localDayKey?: string): string | null {
  if (localWeekday === 0) return 'Domingo'
  if (s.skipHolidays && localDayKey) {
    const feriado = holidayName(localDayKey)
    if (feriado) return `Feriado nacional (${feriado})`
  }
  return null
}

export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

/** "segunda a sexta", "segunda a sábado", "seg, qua e sex" — para a tela. */
export function describeWeekdays(dias: number[]): string {
  const d = [...new Set(dias)].sort()
  if (!d.length) return 'nenhum dia'
  if (d.length === 7) return 'todos os dias'
  const seguido = d.every((v, i) => i === 0 || v === d[i - 1] + 1)
  if (seguido && d.length > 2) return `${WEEKDAY_NAMES[d[0]].toLowerCase()} a ${WEEKDAY_NAMES[d[d.length - 1]].toLowerCase()}`
  const nomes = d.map((x) => WEEKDAY_SHORT[x].toLowerCase())
  return nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
}

// ------------------------------------------------------------ texto da dívida

export interface ChargeLine {
  /** Cadastro do Asaas de onde veio (para o detector de duplicata). */
  customerId?: string | null
  /** Nome do cadastro no Asaas — entra na linha quando o devedor tem mais de
   *  um cadastro (mesma pessoa, duas empresas; João/GoLink 10/09). */
  customerName?: string | null
  value: number
  /** Juros + multa já calculados pelo Asaas (vencida). null/0 = não mostra. */
  interestValue?: number | null
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
export interface SummaryItem {
  line: string
  /** Link de pagamento DESTA parcela (null quando o Asaas não devolveu). */
  url: string | null
}

export interface SummaryOptions {
  /** false = linha sem R$ (só vencimento, atraso e link) e sem "Total". Padrão true. */
  showValues?: boolean
}

export function formatDebtSummary(
  charges: ChargeLine[],
  opts: SummaryOptions = {},
): {
  total: number
  /** Total já com juros e multa do Asaas (= total quando nada foi informado). */
  totalWithInterest: number
  /** Ecoa a opção: quem monta o texto (fallback/IA) sabe se pode citar reais. */
  showValues: boolean
  lines: string[]
  links: string[]
  items: SummaryItem[]
} {
  const showValues = opts.showValues !== false
  const multiAccount = new Set(charges.map((c) => c.connectionLabel)).size > 1
  // Mesma pessoa com dois cadastros (duas empresas): cada linha diz de qual é.
  const multiCustomer = new Set(charges.map((c) => (c.customerName ?? '').trim()).filter(Boolean)).size > 1
  const ordered = [...charges].sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1))
  const interestOf = (c: ChargeLine) => (typeof c.interestValue === 'number' && c.interestValue > 0 ? c.interestValue : 0)

  const items = ordered.map((c) => {
    const atraso = c.daysLate == null ? '' : c.daysLate > 0 ? ` (${c.daysLate} ${c.daysLate === 1 ? 'dia' : 'dias'} de atraso)` : ''
    const conta = multiAccount ? ` — ${c.connectionLabel}` : ''
    const quem = multiCustomer && (c.customerName ?? '').trim() ? ` · ${(c.customerName ?? '').trim()}` : ''
    // 10/09 (João): "tem que exibir o valor total com os juros" — o Asaas já calcula.
    const juros = interestOf(c) > 0 ? ` (${brl(c.value + interestOf(c))} com juros e multa)` : ''
    // 10/09 (João, mais tarde): "remove tudo que é valor, só vencimento, dias e link".
    const valor = showValues ? `${brl(c.value)}${juros} · ` : ''
    const vencimento = showValues ? `venceu em ${br(c.dueDate)}` : `Venceu em ${br(c.dueDate)}`
    return { line: `${valor}${vencimento}${atraso}${quem}${conta}`, url: c.invoiceUrl ?? null }
  })

  const links = [...new Set(ordered.map((c) => c.invoiceUrl).filter((u): u is string => !!u))]
  const total = ordered.reduce((sum, c) => sum + c.value, 0)
  const totalWithInterest = ordered.reduce((sum, c) => sum + c.value + interestOf(c), 0)
  return { total, totalWithInterest, showValues, lines: items.map((i) => i.line), links, items }
}

/** "Total: R$ 400,00 (R$ 425,10 com juros e multa)" — só quando há juros a mostrar. */
export function formatDebtTotal(summary: { total: number; totalWithInterest: number }): string {
  const withInterest = summary.totalWithInterest > summary.total + 0.005 ? ` (${brl(summary.totalWithInterest)} com juros e multa)` : ''
  return `${brl(summary.total)}${withInterest}`
}

/**
 * Corpo da mensagem: uma linha por parcela. Com UMA parcela o link vai no fim
 * ("Para pagar: …"); com várias, cada parcela leva o próprio link logo
 * abaixo — 09/09 (João/GoLink, "quando o cliente tem 3 boletos vencidos"):
 * antes a mensagem com 2+ parcelas saía SEM link nenhum.
 */
export function formatDebtBody(summary: { items: SummaryItem[]; links: string[] }): string {
  const multi = summary.links.length > 1
  return summary.items.map((i) => (multi && i.url ? `• ${i.line}\n  ${i.url}` : `• ${i.line}`)).join('\n')
}

/** Instrução pra IA sobre os links: um só no fim, ou um por parcela. */
export function linksInstruction(summary: { items: SummaryItem[]; links: string[] }): string {
  if (summary.links.length === 1) return `Inclua este link de pagamento no final: ${summary.links[0]}`
  if (summary.links.length > 1) {
    const list = summary.items.filter((i) => i.url).map((i) => `${i.line} → ${i.url}`).join('; ')
    return `São ${summary.links.length} parcelas, cada uma com o próprio link de pagamento. Liste cada parcela com o link dela logo abaixo, sem trocar nem omitir nenhum: ${list}`
  }
  return ''
}

// ------------------------------------------------- lembrete antes de vencer

export interface UpcomingLine {
  value: number
  dueDate: string | null
  /** Dias até vencer (0 = hoje). */
  daysUntil: number | null
  connectionLabel: string
  invoiceUrl: string | null
}

/**
 * Resumo do que AINDA VAI vencer — o texto do lembrete. Mesma regra do resumo
 * da dívida: fatos prontos, a IA só escreve ao redor.
 */
export function formatUpcomingSummary(
  charges: UpcomingLine[],
  opts: SummaryOptions = {},
): { total: number; showValues: boolean; lines: string[]; links: string[]; items: SummaryItem[]; minDays: number | null } {
  const showValues = opts.showValues !== false
  const multiAccount = new Set(charges.map((c) => c.connectionLabel)).size > 1
  const ordered = [...charges].sort((a, b) => (a.daysUntil ?? 999) - (b.daysUntil ?? 999))
  const items: SummaryItem[] = ordered.map((c) => {
    const quando =
      c.daysUntil == null ? '' : c.daysUntil <= 0 ? ' (hoje)' : c.daysUntil === 1 ? ' (amanhã)' : ` (em ${c.daysUntil} dias)`
    const conta = multiAccount ? ` — ${c.connectionLabel}` : ''
    const valor = showValues ? `${brl(c.value)} · ` : ''
    const vencimento = showValues ? `vence em ${br(c.dueDate)}` : `Vence em ${br(c.dueDate)}`
    return { line: `${valor}${vencimento}${quando}${conta}`, url: c.invoiceUrl ?? null }
  })
  const links = [...new Set(ordered.map((c) => c.invoiceUrl).filter((u): u is string => !!u))]
  const days = ordered.map((c) => c.daysUntil).filter((d): d is number => d != null)
  return { total: ordered.reduce((s, c) => s + c.value, 0), showValues, lines: items.map((i) => i.line), links, items, minDays: days.length ? Math.min(...days) : null }
}

/** Texto de segurança do LEMBRETE (sem IA): leve, sem a palavra "atraso". Varia pela semente. */
export function fallbackReminderMessage(
  firstName: string | null,
  summary: ReturnType<typeof formatUpcomingSummary>,
  seed = 0,
  opts: { offerDate?: boolean } = {},
): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const aberturas = [
    `${oi} Passando só pra lembrar: tem um valor que vence em breve por aqui:`,
    `${oi} Tudo bem? Um lembrete rápido do que está para vencer:`,
    `${oi} Só pra você não perder a data, fica o lembrete:`,
    `${oi} Aviso amigo: está chegando o vencimento de:`,
  ]
  const fechos = [
    'Se já estiver programado, pode ignorar esta mensagem 😉',
    'Qualquer dúvida, é só responder por aqui.',
    opts.offerDate === false ? 'Se já pagou, desconsidere.' : 'Se precisar de outra data, me avisa por aqui que a gente vê.',
    'Se já pagou, desconsidere — e obrigado!',
  ]
  const s = seed >>> 0
  // 2+ parcelas: cada uma sai com o próprio link embaixo (antes, com mais de
  // um link a mensagem ia SEM link nenhum — João/GoLink, 09/09).
  const corpo = formatDebtBody(summary)
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${aberturas[s % 4]}\n\n${corpo}${link}\n\n${fechos[(s >>> 2) % 4]}`
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
export function fallbackMessage(
  firstName: string | null,
  summary: ReturnType<typeof formatDebtSummary>,
  touch: number,
  seed = 0,
  opts: { offerDate?: boolean } = {},
): string {
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
  // Sem "combinar uma data" quando a empresa não quer abrir essa porta
  // (João/GoLink 10/09). A resposta do cliente continua pausando a régua.
  const fechos =
    opts.offerDate === false
      ? [
          'Se já pagou, é só me avisar por aqui.',
          'Se já tiver pago, me responde por aqui que eu confiro.',
          'Já pagou? Me conta por aqui.',
          'Qualquer dúvida, é só responder esta mensagem.',
        ]
      : [
          'Se já pagou ou quiser combinar uma data, é só me dizer por aqui.',
          'Se já tiver pago, me avisa por aqui; se preferir combinar uma data, também é só falar.',
          'Já pagou? Me conta por aqui. Se quiser combinar uma data, a gente vê junto.',
          'Qualquer dúvida, ou se quiser combinar uma data, é só responder esta mensagem.',
        ]
  const s = seed >>> 0
  const abre = (touch === 0 ? primeiras : seguintes)[s % 4]
  const corpo = formatDebtBody(summary)
  const total = summary.lines.length > 1 && summary.showValues !== false ? `\n\nTotal: ${formatDebtTotal(summary)}` : ''
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

// ---------------------------------------------------------- duplicata
/**
 * Mesmo valor e mesmo vencimento em DOIS cadastros diferentes do Asaas é,
 * quase sempre, o mesmo boleto criado duas vezes (Renato ×3, 05/09: 12
 * parcelas em dobro). A régua NÃO cobra esse devedor até uma pessoa resolver
 * no Asaas — cobrar em dobro é pior que atrasar um dia.
 */
export function duplicateSuspects(charges: { customerId?: string | null; value: number; dueDate: string | null }[]): boolean {
  const byKey = new Map<string, Set<string>>()
  for (const c of charges) {
    if (!c.customerId || !c.dueDate) continue
    const k = `${c.value.toFixed(2)}|${c.dueDate.slice(0, 10)}`
    const ids = byKey.get(k) ?? new Set<string>()
    ids.add(c.customerId)
    byKey.set(k, ids)
    if (ids.size > 1) return true
  }
  return false
}

// ============================================================
// 🔗 Aviso de COBRANÇA NOVA — REGRAS (puras, testáveis, client-safe).
//
// Por que existe (17/09, GoLink): o aviso NUNCA disparou. Ele lia
// `asaas_charges`, que só espelha VENCIDAS — a cobrança PENDING criada no
// painel do Asaas só entrava lá depois de vencer, fora da janela de 2 dias.
// Em 15/09 o João criou Alpha Gás, Leva Entulho (3x), Andressa Amorelli e
// Convictus no painel e mandou os 4 links à mão, do celular, entre 17:37 e
// 18:20. Com os avisos do Asaas desligados, sem ele ninguém teria mandado nada
// até vencer.
//
// Agora a varredura pergunta ao Asaas, AO VIVO, o que nasceu nos últimos dias
// (`dateCreated[ge]`), e estas regras decidem o que é cobrança nova de verdade:
//   · 78 cobranças criadas de 10 a 17/09 nas duas contas: 59 renovações de
//     assinatura (o Asaas gera 39 dias antes do vencimento), 10 "Pix recebido
//     gerado automaticamente", 2 do CRM (Dom Burguer) e 7 do painel;
//   · renovação e parcelas 2..N vencem longe → ficam com o lembrete D-5;
//   · Pix recebido não está em aberto → fora;
//   · o que o CRM criou já mandou o link na criação → fora.
//
// Sem banco e sem 'server-only': roda no worker e nos testes.
// ============================================================

/** Dias de ENVIO (não corridos) em que a cobrança ainda conta como nova. Sexta 17h30 → segunda 9h. */
export const NEW_CHARGE_SENDING_DAYS = 2

/**
 * Até quantos dias à frente o vencimento ainda pede o link na criação.
 * As renovações de assinatura nascem 39 dias antes (59 de 59 na GoLink) e as
 * parcelas 2..N de um parcelamento vencem a 30+ dias: essas o lembrete D-5
 * cobre. ⚠️ Conta com lembrete desligado (reminderDaysBefore=0) não recebe
 * nada antes de vencer para cobrança a mais de 15 dias — limitação aceita.
 */
export const NEW_CHARGE_HORIZON_DAYS = 15

/**
 * Carência entre a fila e o envio (minutos). O João cria no painel e cola o
 * link à mão 2 a 8 min depois; sem carência o sender podia mandar antes do eco
 * da mensagem dele chegar, e o cliente recebia o link duas vezes. Passada a
 * carência, o executor confere se o link já chegou.
 */
export const NEW_CHARGE_GRACE_MIN = 30

/**
 * Recusa do executor quando o link já chegou ao cliente. Casa com
 * COLLECTION_FINAL_ERROR_RE ("não foi enviada"): o sender encerra como
 * 'expired' sem tentar de novo, e o scanner remonta só o que faltar.
 */
export const NEW_CHARGE_LINK_SENT_ERROR = 'O link desta cobrança já chegou ao cliente — a mensagem não foi enviada de novo.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Só UUID pode ser referência do CRM (conversa, contato ou conta). Código de ERP não. */
export function isUuidRef(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v.trim())
}

/** Dia da semana de um 'YYYY-MM-DD' (meio-dia UTC: o fuso do servidor nunca muda o dia). */
export const weekdayOfYmd = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay()

/** 'YYYY-MM-DD' somado de N dias (calendário, sem fuso). */
export function addDaysYmd(ymd: string, n: number): string {
  const t = Date.parse(`${ymd.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(t)) return ymd
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10)
}

/** Dias de calendário de `from` até `to` (positivo = `to` no futuro). null se alguma data é inválida. */
export function daysBetweenYmd(from: string, to: string): number | null {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86_400_000)
}

/**
 * Desde que dia (inclusive) uma cobrança ainda é "nova": volta N dias de ENVIO
 * antes de hoje (dia em que a régua fala — dia da semana e feriado da conta).
 * Hoje segunda 21/09 com 2 dias → quinta 17/09: a de sexta 17h30 entra.
 *
 * Nunca antes de nenhum piso: o dia em que a conexão foi ligada (tudo antes é
 * carga inicial) e o dia SEGUINTE à primeira varredura depois de ligar "o CRM
 * assume os avisos" (até lá o Asaas avisava sozinho — `ligaAvisosFloor`).
 *
 * Piso no futuro NÃO é trazido para hoje (revisão 17/09): no dia em que a
 * opção é ligada o piso é amanhã, e trazer para hoje punha na janela a
 * cobrança das 08:00 que o Asaas já tinha avisado — a varredura das 10:30
 * calava o cliente e o CRM mandava o link de novo. Devolve o piso como está;
 * quem chama vê `since > hoje` e pula a conexão (sem janela até amanhã).
 */
export function newChargeSince(
  todayKey: string,
  floors: readonly (string | null | undefined)[],
  isSendingDay: (ymd: string) => boolean,
  n = NEW_CHARGE_SENDING_DAYS,
): string {
  let since = todayKey
  let achados = 0
  // Teto de 60 voltas: conta que só cobra num dia da semana não trava o laço.
  for (let i = 1; i <= 60 && achados < n; i++) {
    const dia = addDaysYmd(todayKey, -i)
    if (isSendingDay(dia)) {
      achados += 1
      since = dia
    }
  }
  for (const f of floors) {
    const piso = typeof f === 'string' ? f.slice(0, 10) : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(piso) && piso > since) since = piso
  }
  return since
}

/**
 * Piso do "CRM assume os avisos": o dia SEGUINTE à primeira varredura completa
 * DEPOIS de ligar a opção — não o dia seguinte ao clique (revisão 17/09).
 *
 * Por quê: o Asaas só para de avisar quando a varredura desliga os clientes, e
 * ela só roda numa rodada dentro do horário. Ligada na sexta 17h30, a primeira
 * varredura é segunda 9h: as cobranças de sábado e domingo o Asaas avisou, e
 * com o piso no sábado (dia seguinte ao clique) o CRM mandava de novo na segunda.
 *
 * - `offAt` null: conta que já tinha ligado antes de existir o campo (GoLink) —
 *   sem piso, como antes;
 * - sem varredura, ou varredura anterior ao `offAt` (desligou e religou):
 *   `wait` — a varredura de cobrança nova não roda até a próxima (que a
 *   sincronização antecipa: `fullSweepReason`);
 * - senão: dia seguinte (no fuso da conta) ao instante da varredura.
 */
export function ligaAvisosFloor(
  offAt: string | null | undefined,
  sweptAt: string | null | undefined,
  dayOf: (iso: string) => string,
): { wait: true } | { wait: false; floor: string | null } {
  const off = offAt ? Date.parse(offAt) : Number.NaN
  if (Number.isNaN(off)) return { wait: false, floor: null }
  const varrida = sweptAt ? Date.parse(sweptAt) : Number.NaN
  if (Number.isNaN(varrida) || varrida < off) return { wait: true }
  return { wait: false, floor: addDaysYmd(dayOf(new Date(varrida).toISOString()), 1) }
}

/** Por que a sincronização varre agora TODOS os clientes da conexão (null = só a carteira). */
export type FullSweepReason =
  /** A conta espera a 1ª varredura completa depois de ligar "o CRM assume os avisos". */
  | 'espera_varredura'
  /** A última varredura completa DESTA conexão é de antes do clique (a outra conta do Asaas já varreu). */
  | 'conexao_antes_do_clique'
  /** Rotina: uma vez a cada `everyMs` (cliente novo nasce no Asaas com aviso ligado). */
  | 'rotina'

/**
 * A sincronização desta conexão varre TODOS os clientes do Asaas agora, e não
 * só os da carteira vencida? null = não.
 *
 * Revisão 17/09 (aviso de cobrança nova): ligar "o CRM assume os avisos" zera
 * `asaasNotificationsSweptAt`, mas o portão de rotina (20 h) olha a última
 * varredura da CONEXÃO, não o clique. Com a conexão varrida há pouco — o selo
 * "desligar avisos do Asaas" clicado antes de marcar a opção (o texto de ajuda
 * manda usar o selo), ou desmarcar e remarcar numa conta com a varredura diária
 * — nada varria por até um dia: o aviso ficava em "aguardando_varredura" e, com
 * o piso no dia seguinte à varredura, as cobranças criadas nesse meio-tempo
 * viravam "antiga" para sempre. Com o cliente já calado, nem o Asaas nem o CRM
 * mandavam o link. Varrer logo é tão seguro quanto a 1ª varredura de uma conexão
 * nova: o piso continua sendo o dia seguinte a ela.
 *
 * - `espera_varredura`: enquanto a conta espera (`ligaAvisosFloor` → wait). A
 *   listagem que falhou não grava a varredura, então a espera continua e a
 *   próxima sincronização tenta de novo — não volta para o portão de 20 h, que
 *   a mesma tentativa falha já teria renovado na conexão;
 * - `conexao_antes_do_clique`: com duas contas do Asaas, a 1ª varrida grava a
 *   varredura da conta; a outra, varrida antes do clique, não fica mais um dia
 *   com os clientes novos avisados (e cobrados) pelo Asaas;
 * - `rotina`: nunca varrida, ou há mais de `everyMs`.
 *
 * Conta que ligou antes de existir o campo (`offAt` null, GoLink) segue só a rotina.
 */
export function fullSweepReason(p: {
  nowMs: number
  /** Última varredura completa desta conexão (`asaas_connections.notifications_off_at`). */
  lastSweepAt: string | null | undefined
  /** Quando "o CRM assume os avisos" foi ligado (ajustes). */
  offAt: string | null | undefined
  /** 1ª varredura completa depois de ligar (ajustes). */
  sweptAt: string | null | undefined
  everyMs: number
}): FullSweepReason | null {
  // Para saber se espera, o dia não importa (só o `wait`).
  if (ligaAvisosFloor(p.offAt, p.sweptAt, (iso) => iso.slice(0, 10)).wait) return 'espera_varredura'
  const ultima = p.lastSweepAt ? Date.parse(p.lastSweepAt) : Number.NaN
  if (Number.isNaN(ultima)) return 'rotina'
  const ligou = p.offAt ? Date.parse(p.offAt) : Number.NaN
  if (!Number.isNaN(ligou) && ultima < ligou) return 'conexao_antes_do_clique'
  return p.nowMs - ultima > p.everyMs ? 'rotina' : null
}

/** Os campos da cobrança do Asaas que a classificação lê. */
export interface NewChargePayment {
  id: string
  status: string
  dateCreated?: string | null
  dueDate?: string | null
  invoiceUrl?: string | null
  externalReference?: string | null
  installment?: string | null
  subscription?: string | null
  billingType?: string | null
  /** Link de pagamento do Asaas de onde o próprio cliente gerou a cobrança. */
  paymentLink?: string | null
  /** Checkout do Asaas de onde o próprio cliente gerou a cobrança. */
  checkoutSession?: string | null
}

export type NewChargeVerdict =
  | 'ok'
  /** Não está em aberto (Pix recebido gerado automaticamente, paga, cancelada). */
  | 'status'
  | 'sem_link'
  /** Nasceu antes da janela de envio (ou sem data: na dúvida, calar). */
  | 'antiga'
  /** Já tem aviso de cobrança nova (fora falho/expirado). */
  | 'ja_avisado'
  /** O CRM criou (por id, pela referência ou pelo grupo): o link saiu na criação. */
  | 'criada_pelo_crm'
  /** O próprio cliente gerou num link de pagamento/checkout do Asaas: ele já está com o boleto na tela. */
  | 'gerada_pelo_cliente'
  /** Vence além do horizonte: renovação, parcelas 2..N — trabalho do lembrete D-5. */
  | 'vence_longe'
  /** Mensalidade no cartão de crédito: o Asaas debita sozinho, "segue o link" confunde. */
  | 'cartao_recorrente'

export interface NewChargeContext {
  since: string
  todayKey: string
  horizonDays?: number
  /** asaasIds já avisados (antes do GET de cliente — poupa chamada). */
  noticed: ReadonlySet<string>
  /** asaasIds que o CRM criou (asaas_charges com origin <> 'sync'). */
  crmPaymentIds: ReadonlySet<string>
  /** externalReference (minúsculo) confirmados como conversa/contato/conta do CRM. */
  crmRefs: ReadonlySet<string>
  /** installment/subscription de uma parcela criada pelo CRM. */
  crmGroups: ReadonlySet<string>
}

const OPEN_STATUSES = new Set(['PENDING', 'OVERDUE'])

/**
 * É cobrança nova que o cliente ainda não recebeu? A ordem importa: tudo que se
 * decide sem banco vem antes, e `ja_avisado` antes de abrir o cadastro do
 * cliente no Asaas (a cada tique de 10 min isso vira chamada).
 *
 * Cobrança que nasceu já vencida (OVERDUE) dentro da janela vale: o cliente
 * nunca recebeu o link. A régua pode cobrar de novo depois do atraso mínimo.
 */
export function classifyNewCharge(p: NewChargePayment, ctx: NewChargeContext): NewChargeVerdict {
  if (!OPEN_STATUSES.has(String(p.status ?? '').toUpperCase())) return 'status'
  if (!(p.invoiceUrl ?? '').trim()) return 'sem_link'
  const criada = (p.dateCreated ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(criada) || criada < ctx.since) return 'antiga'
  if (ctx.noticed.has(p.id)) return 'ja_avisado'
  // UUID do banco é minúsculo; quem monta crmRefs também grava minúsculo.
  const ref = (p.externalReference ?? '').trim().toLowerCase()
  if (
    ctx.crmPaymentIds.has(p.id) ||
    (ref && ctx.crmRefs.has(ref)) ||
    (p.installment && ctx.crmGroups.has(p.installment)) ||
    (p.subscription && ctx.crmGroups.has(p.subscription))
  ) {
    return 'criada_pelo_crm'
  }
  // Revisão 17/09: conta que divulga um link de pagamento do Asaas — o cliente
  // abre, escolhe boleto e a cobrança nasce sem referência. "Segue o link para
  // pagamento" 30 min depois, para quem acabou de gerar, parece robô quebrado.
  if ((p.paymentLink ?? '').trim() || (p.checkoutSession ?? '').trim()) return 'gerada_pelo_cliente'
  const dias = p.dueDate ? daysBetweenYmd(ctx.todayKey, p.dueDate) : null
  if (dias == null || dias > (ctx.horizonDays ?? NEW_CHARGE_HORIZON_DAYS)) return 'vence_longe'
  if (p.subscription && String(p.billingType ?? '').toUpperCase() === 'CREDIT_CARD') return 'cartao_recorrente'
  return 'ok'
}

/** Aviso de "cobrança criada" do próprio Asaas para um cliente (GET /customers/{id}/notifications). */
export interface PaymentCreatedFlags {
  /** PAYMENT_CREATED ligado. */
  enabled: boolean
  /** Canais PARA O CLIENTE ligados nesse evento. */
  email: boolean
  sms: boolean
  whatsapp: boolean
  phoneCall: boolean
}

/**
 * O que o CRM guardou quando desligou os avisos do Asaas de um cliente
 * (`asaas-silenced.ts`, Redis com validade). Sem isso não dá para saber se o
 * cliente já estava calado quando a cobrança nasceu: o `notificationDisabled`
 * que o Asaas devolve é o de AGORA, e a data de criação só tem o dia.
 */
export interface SilencedRecord {
  /** Quando o CRM desligou (ISO). */
  at: string
  /** Primeiro dia (YYYY-MM-DD) coberto pela lista `before`. */
  beforeSince?: string | null
  /**
   * Cobranças do cliente que já existiam quando ele foi calado (listadas logo
   * DEPOIS do PUT: a que nasceu nesses segundos conta como avisada pelo Asaas —
   * no máximo um aviso a menos, nunca dobrado). Ausente = não deu para listar.
   */
  before?: readonly string[] | null
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/
const temValor = (v: string | null | undefined) => !!(v ?? '').trim()

/**
 * O Asaas CONSEGUE entregar o aviso de cobrança criada a este cliente? Canal
 * ligado sem o dado do canal não entrega nada (revisão 17/09): cliente só com
 * celular e só o e-mail ligado ficava sem o link — o Asaas não mandava (não há
 * endereço) e o CRM achava que ele mandou. SMS e WhatsApp vão para o celular;
 * a ligação, para o fixo ou o celular.
 */
export function asaasReachesCustomer(
  f: PaymentCreatedFlags,
  c: { email?: string | null; mobilePhone?: string | null; phone?: string | null },
): boolean {
  if (!f.enabled) return false
  return (
    (f.email && temValor(c.email)) ||
    ((f.sms || f.whatsapp) && temValor(c.mobilePhone)) ||
    (f.phoneCall && (temValor(c.phone) || temValor(c.mobilePhone)))
  )
}

/**
 * O cliente já estava calado quando a cobrança nasceu?
 *
 * Revisão 17/09 — antes comparava a criação do CLIENTE com o `since`, que anda
 * um dia por dia: a mesma cobrança dava "o Asaas avisa" na quarta e na quinta e
 * "não avisa" na sexta (cliente criado terça 14h, cobrança quarta 08:00, varredura
 * quarta 9h) — e o CRM mandava na sexta o link que o Asaas mandou na quarta. E o
 * contrário: cliente calado dentro da janela caía nas chaves por evento (que o
 * Asaas não mexe ao calar) e ninguém avisava. Agora a âncora é o que não muda:
 * a cobrança e o registro de quando o CRM calou o cliente.
 *
 *   - sem leitura do registro (Redis fora) → 'nao_sei' (as chaves decidem);
 *   - sem registro → 'antes': o cliente nasceu calado (ERP/API, ou o CRM criou)
 *     ou foi calado há mais tempo que a validade do registro (35 dias, maior que
 *     qualquer janela). ⚠️ No dia do deploy, cliente calado por varredura antiga
 *     não tem registro — pode dobrar o aviso de uma cobrança criada antes dessa
 *     varredura, só em cliente com PAYMENT_CREATED ligado (GoLink tem desligado);
 *   - com a lista do que já existia ao calar e a cobrança no período da lista →
 *     está na lista = 'depois' (nasceu com o Asaas ligado, ou nos segundos até a
 *     lista — conta como avisada, nunca dobra); não está = 'antes';
 *   - sem a lista, pelo DIA: cobrança de dia anterior ao calar = 'depois';
 *     de dia posterior = 'antes'; do MESMO dia, 'depois' só se o cliente também
 *     nasceu nesse dia (criados juntos antes da varredura das 9h) — a cobrança
 *     do painel é de horário comercial, depois da varredura.
 */
export function silencedBeforeCharge(
  c: { dateCreated?: string | null },
  chargeId: string,
  chargeCreated: string,
  silenced: SilencedRecord | null | undefined,
  dayOf: (iso: string) => string,
): 'antes' | 'depois' | 'nao_sei' {
  if (silenced === undefined) return 'nao_sei'
  if (silenced === null) return 'antes'
  const at = Date.parse(silenced.at)
  const criadaEm = chargeCreated.slice(0, 10)
  if (Number.isNaN(at) || !YMD_RE.test(criadaEm)) return 'nao_sei'
  const desde = (silenced.beforeSince ?? '').slice(0, 10)
  if (Array.isArray(silenced.before) && YMD_RE.test(desde) && criadaEm >= desde) {
    return silenced.before.includes(chargeId) ? 'depois' : 'antes'
  }
  const diaCalado = dayOf(new Date(at).toISOString())
  if (criadaEm < diaCalado) return 'depois'
  if (criadaEm > diaCalado) return 'antes'
  return (c.dateCreated ?? '').slice(0, 10) === diaCalado ? 'depois' : 'antes'
}

/**
 * O PRÓPRIO Asaas avisa (ou avisou) este cliente da cobrança criada? Se sim, o
 * CRM não manda: dois avisos do mesmo link é pior que um.
 *
 * Casos em que ele ainda avisa, mesmo com a conta tendo desligado:
 *   1. a varredura foi recusada ("possui cobranças agendadas", assinatura ativa);
 *   2. cliente criado no painel depois da varredura do dia — nasce com aviso
 *      ligado e a cobrança nasce antes de a varredura seguinte calar;
 *   3. conta que acabou de ligar o "CRM assume os avisos" (piso em `ligaAvisosFloor`).
 * Andressa e Convictus (15/09) estão com PAYMENT_CREATED desligado em todos os
 * canais; o Dom Burguer, criado pelo CRM, com SMS ligado — por isso olhar.
 *
 * O veredito é o mesmo em todos os dias da janela: não depende de "hoje".
 * 'need_flags' = só o GET das chaves por evento decide (cache na rodada).
 */
export function asaasNotifies(
  c: {
    notificationDisabled?: boolean | null
    dateCreated?: string | null
    externalReference?: string | null
    email?: string | null
    mobilePhone?: string | null
    phone?: string | null
  },
  ctx: {
    chargeId: string
    /** Dia de criação da cobrança (YYYY-MM-DD, como o Asaas devolve). */
    chargeCreated: string
    isCrmRef: (ref?: string | null) => boolean
    /** Registro de quando o CRM calou o cliente: null = não há; undefined = não deu para ler. */
    silenced: SilencedRecord | null | undefined
    /** Dia local (fuso da conta) de um instante ISO. */
    dayOf: (iso: string) => string
  },
  flags?: PaymentCreatedFlags | null,
): 'yes' | 'no' | 'need_flags' {
  // Cliente criado pelo CRM nasce com os avisos desligados (findOrCreateCustomer).
  if (ctx.isCrmRef(c.externalReference)) return 'no'
  if (c.notificationDisabled === true && silencedBeforeCharge(c, ctx.chargeId, ctx.chargeCreated, ctx.silenced, ctx.dayOf) === 'antes') {
    return 'no'
  }
  // Ligado, ou calado DEPOIS de a cobrança nascer: o Asaas avisou se as chaves
  // do evento estavam ligadas e o canal tem para onde mandar.
  if (!flags) return 'need_flags'
  return asaasReachesCustomer(flags, c) ? 'yes' : 'no'
}

/** Pedido de aviso criado depois deste instante ainda está na carência (sender). */
export function newChargeGraceCutoffIso(nowMs: number, min = NEW_CHARGE_GRACE_MIN): string {
  return new Date(nowMs - min * 60_000).toISOString()
}

/**
 * Os pedidos que contam como "já lembrado" para o lembrete D-5.
 *
 * Aviso de cobrança nova só conta se foi criado a partir de `newChargeCountsSinceIso`
 * (reminderDaysBefore+1 dias). Com o horizonte de 15 dias, a parcela avisada
 * 6 a 15 dias antes perdia o lembrete perto do vencimento (Alpha Gás: criada
 * 15/09, vence 26/09 — o lembrete de 21/09 não sairia). Lembrete conta sempre.
 */
export function remindedFilter<T extends { kind?: unknown; createdAt: string | null; contactId: string | null; payload: unknown }>(
  rows: readonly T[],
  newChargeCountsSinceIso: string,
): T[] {
  const corte = Date.parse(newChargeCountsSinceIso)
  return rows.filter((r) => {
    const kind = r.kind ?? (r.payload as { kind?: unknown } | null)?.kind
    if (kind === 'reminder') return true
    if (kind !== 'new_charge') return false
    const t = r.createdAt ? Date.parse(r.createdAt) : Number.NaN
    return !Number.isNaN(t) && !Number.isNaN(corte) && t >= corte
  })
}

/** Descrição do painel do Asaas pode ter parágrafos: uma linha, cortada. */
export function shortChargeDescription(raw: string | null | undefined, max = 60): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim()
  // Por caractere (Array.from): emoji partido ao meio vira "�" na mensagem.
  const chars = Array.from(t)
  if (chars.length <= max) return t
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

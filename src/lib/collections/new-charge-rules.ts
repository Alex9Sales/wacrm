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
 * carga inicial) e o dia SEGUINTE a ligar "o CRM assume os avisos" (até lá o
 * Asaas avisava sozinho — mandar de novo seria dobrado).
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
  // Piso no futuro (relógio torto) não pode esconder o dia de hoje.
  return since > todayKey ? todayKey : since
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
  const dias = p.dueDate ? daysBetweenYmd(ctx.todayKey, p.dueDate) : null
  if (dias == null || dias > (ctx.horizonDays ?? NEW_CHARGE_HORIZON_DAYS)) return 'vence_longe'
  if (p.subscription && String(p.billingType ?? '').toUpperCase() === 'CREDIT_CARD') return 'cartao_recorrente'
  return 'ok'
}

/** Aviso de "cobrança criada" do próprio Asaas para um cliente (GET /customers/{id}/notifications). */
export interface PaymentCreatedFlags {
  enabled: boolean
  /** Algum canal PARA O CLIENTE ligado (e-mail, SMS, WhatsApp, ligação). */
  anyChannel: boolean
}

/**
 * O PRÓPRIO Asaas avisa (ou avisou) este cliente da cobrança criada? Se sim, o
 * CRM não manda: dois avisos do mesmo link é pior que um.
 *
 * Três casos em que ele ainda avisa, mesmo com a conta tendo desligado:
 *   1. a varredura foi recusada ("possui cobranças agendadas", assinatura ativa);
 *   2. cliente criado no painel depois da varredura do dia — nasce com aviso
 *      ligado; a varredura da manhã seguinte desliga e apaga o rastro;
 *   3. conta que acabou de ligar o "CRM assume os avisos" (piso em newChargeSince).
 * Andressa e Convictus (15/09) estão com PAYMENT_CREATED desligado em todos os
 * canais; o Dom Burguer, criado pelo CRM, com SMS ligado — por isso olhar.
 *
 * 'need_flags' = só o GET das chaves por evento decide (cache na rodada).
 */
export function asaasNotifies(
  c: { notificationDisabled?: boolean | null; dateCreated?: string | null; externalReference?: string | null },
  ctx: { since: string; isCrmRef: (ref?: string | null) => boolean },
  flags?: PaymentCreatedFlags | null,
): 'yes' | 'no' | 'need_flags' {
  // Cliente criado pelo CRM nasce com os avisos desligados (findOrCreateCustomer).
  if (ctx.isCrmRef(c.externalReference)) return 'no'
  const criado = (c.dateCreated ?? '').slice(0, 10)
  // Já estava calado antes da janela: a varredura desligou antes da cobrança nascer.
  if (c.notificationDisabled === true && /^\d{4}-\d{2}-\d{2}$/.test(criado) && criado < ctx.since) return 'no'
  if (!flags) return 'need_flags'
  return flags.enabled && flags.anyChannel ? 'yes' : 'no'
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

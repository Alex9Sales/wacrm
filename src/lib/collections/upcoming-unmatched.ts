// ============================================================
// 🔔 A vencer sem contato no CRM (16/09, Speed Gás e Água / GoLink).
//
// A parcela a vencer de um cliente do Asaas que não casava com nenhum contato
// era invisível: o lembrete antes do vencimento pulava ("no_contact") e só o
// log do worker sabia — e o log se perdeu quando o container foi recriado. O
// cliente não recebeu o aviso, e ninguém na equipe tinha como saber.
//
// Agora cada rodada do lembrete grava um RETRATO de quem vai vencer e não casou
// (collections_upcoming_unmatched) e a tela /cobrancas mostra, com "Ligar a um
// contato" e "Criar contato". Nada aqui cria contato nem vínculo sozinho.
//
// Parte PURA (sem banco, sem 'server-only'): montar o retrato a partir das
// parcelas lidas, decidir o que a limpeza pode apagar e o que a tela mostra.
// ============================================================

import { asaasPhoneForContact, normalizeDocument, normalizeEmail } from '@/lib/asaas/match'
import type { DebtorHold } from './rules'

/** no_contact = ninguém tem o telefone/e-mail/documento · ambiguous = 2+ contatos com o mesmo telefone (ou, sem telefone que case, o mesmo e-mail/documento). */
export type UnmatchedReason = 'no_contact' | 'ambiguous'

export interface UnmatchedPayment {
  id: string
  value: number
  /** YYYY-MM-DD */
  dueDate: string | null
  invoiceUrl: string | null
  description: string | null
}

/** Uma parcela sem contato, como o lembrete leu nesta rodada. */
export interface UnmatchedEntry {
  connectionId: string
  customerId: string
  customer: {
    name?: string | null
    mobilePhone?: string | null
    phone?: string | null
    email?: string | null
    cpfCnpj?: string | null
  }
  reason: UnmatchedReason
  payment: {
    id: string
    value?: number | null
    dueDate?: string | null
    invoiceUrl?: string | null
    description?: string | null
  }
}

/** Um cartão do retrato: um cliente do Asaas, numa conta do Asaas. */
export interface UnmatchedRow {
  connectionId: string
  customerId: string
  name: string | null
  phone: string | null
  email: string | null
  cpfCnpj: string | null
  reason: UnmatchedReason
  /** Em ordem de vencimento. */
  payments: UnmatchedPayment[]
  nextDueDate: string | null
  total: number
}

export interface UnmatchedCustomerRef {
  connectionId: string
  customerId: string
  /**
   * Nome no Asaas, gravado no vínculo (migr 0179). Cliente que só tem parcela a
   * vencer some do retrato ao ser ligado e não está na carteira: sem o nome no
   * vínculo, "Ligados nos últimos dias" só mostraria o cus_ (16/09).
   */
  customerName?: string | null
}

const blankToNull = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim()
  return t ? t : null
}

const byDueDate = (a: UnmatchedPayment, b: UnmatchedPayment): number => {
  if (a.dueDate === b.dueDate) return 0
  if (!a.dueDate) return 1
  if (!b.dueDate) return -1
  return a.dueDate < b.dueDate ? -1 : 1
}

/** Soma em centavos: 350,00 + 0,10 não pode virar 350,09999. */
function sumTotal(payments: readonly UnmatchedPayment[]): number {
  return payments.reduce((cents, p) => cents + Math.round((Number.isFinite(p.value) ? p.value : 0) * 100), 0) / 100
}

function minDue(payments: readonly UnmatchedPayment[]): string | null {
  let min: string | null = null
  for (const p of payments) if (p.dueDate && (min === null || p.dueDate < min)) min = p.dueDate
  return min
}

/**
 * Agrupa as parcelas sem contato por (conta do Asaas, cliente). O mesmo cus_
 * em duas conexões são dois cartões — o id é por conta do Asaas. Se alguma
 * parcela veio "ambiguous", o cartão inteiro é ambíguo (criar contato ali
 * seria chute).
 */
export function buildUnmatchedRows(entries: readonly UnmatchedEntry[]): UnmatchedRow[] {
  const rows = new Map<string, UnmatchedRow>()
  for (const e of entries) {
    if (!e.customerId || !e.payment?.id) continue
    const key = customerRefKey({ connectionId: e.connectionId, customerId: e.customerId })
    let row = rows.get(key)
    if (!row) {
      row = {
        connectionId: e.connectionId,
        customerId: e.customerId,
        name: blankToNull(e.customer.name),
        phone: blankToNull(e.customer.mobilePhone) ?? blankToNull(e.customer.phone),
        email: blankToNull(e.customer.email),
        cpfCnpj: blankToNull(e.customer.cpfCnpj),
        reason: e.reason,
        payments: [],
        nextDueDate: null,
        total: 0,
      }
      rows.set(key, row)
    }
    if (e.reason === 'ambiguous') row.reason = 'ambiguous'
    if (row.payments.some((p) => p.id === e.payment.id)) continue
    const value = Number(e.payment.value ?? 0)
    row.payments.push({
      id: e.payment.id,
      value: Number.isFinite(value) ? value : 0,
      dueDate: e.payment.dueDate ? e.payment.dueDate.slice(0, 10) : null,
      invoiceUrl: blankToNull(e.payment.invoiceUrl),
      description: blankToNull(e.payment.description),
    })
  }
  return [...rows.values()].map((r) => {
    const payments = [...r.payments].sort(byDueDate)
    return { ...r, payments, nextDueDate: minDue(payments), total: sumTotal(payments) }
  })
}

/** YYYY-MM-DD + N dias (conta de calendário, sem fuso). */
export function addDaysKey(ymd: string, days: number): string {
  const t = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(t)) return ymd
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * O que a tela mostra: só as parcelas que vencem de HOJE até hoje+N dias (a
 * janela do lembrete), com total e próximo vencimento refeitos. Filtra pelas
 * parcelas, não pela menor data do cartão: cliente com uma de ontem (já
 * venceu, vai para a carteira) e outra de amanhã continua aparecendo pela de
 * amanhã. Cartão sem parcela visível some.
 */
export function visibleUpcoming<T extends { payments: UnmatchedPayment[]; nextDueDate: string | null; total: number }>(
  rows: readonly T[],
  todayKey: string,
  days: number,
): T[] {
  const until = addDaysKey(todayKey, Math.max(0, days))
  const out: T[] = []
  for (const r of rows) {
    const payments = (r.payments ?? []).filter((p) => !!p.dueDate && p.dueDate >= todayKey && p.dueDate <= until)
    if (!payments.length) continue
    out.push({ ...r, payments, nextDueDate: minDue(payments), total: sumTotal(payments) })
  }
  return out
}

/**
 * O que a limpeza do retrato pode apagar depois de uma leitura. Cliente que o
 * Asaas não deixou abrir nesta rodada NÃO é gravado (seria um cartão sem nome
 * nem telefone) e também não é apagado (o cartão bom de antes continua). Se a
 * leitura dos clientes falhou inteira (429), não limpa nada.
 */
export function purgePlan(input: { customersOk: boolean; unknownCustomerIds: Iterable<string> }): { purge: boolean; keep: string[] } {
  return { purge: input.customersOk, keep: [...new Set([...input.unknownCustomerIds].filter(Boolean))] }
}

/**
 * Para a dica "outro cadastro com o mesmo CPF/CNPJ" do cartão: quantos OUTROS
 * cartões têm o mesmo documento. Só dica — ligar o outro é um clique próprio
 * (o mesmo CPF de um MEI pode ter dois negócios com WhatsApp diferente).
 */
export function sameDocumentOthers(rows: readonly { connectionId: string; customerId: string; cpfCnpj: string | null }[]): Map<string, number> {
  const byDoc = new Map<string, number>()
  for (const r of rows) {
    const d = normalizeDocument(r.cpfCnpj)
    if (d) byDoc.set(d, (byDoc.get(d) ?? 0) + 1)
  }
  const out = new Map<string, number>()
  for (const r of rows) {
    const d = normalizeDocument(r.cpfCnpj)
    out.set(customerRefKey(r), d ? (byDoc.get(d) ?? 1) - 1 : 0)
  }
  return out
}

export function customerRefKey(r: { connectionId: string; customerId: string }): string {
  return `${r.connectionId}:${r.customerId}`
}

/**
 * (conexão, cliente) sem repetição, ignorando cobrança sem cliente do Asaas.
 * Leva junto o primeiro nome não vazio (quando a linha traz) — vai para o vínculo.
 */
export function uniqueCustomerRefs(
  list: readonly { connectionId: string; asaasCustomerId: string | null; customerName?: string | null }[],
): UnmatchedCustomerRef[] {
  const seen = new Map<string, UnmatchedCustomerRef>()
  for (const r of list) {
    if (!r.asaasCustomerId) continue
    const key = customerRefKey({ connectionId: r.connectionId, customerId: r.asaasCustomerId })
    const name = seen.get(key)?.customerName || blankToNull(r.customerName)
    seen.set(key, name ? { connectionId: r.connectionId, customerId: r.asaasCustomerId, customerName: name } : { connectionId: r.connectionId, customerId: r.asaasCustomerId })
  }
  return [...seen.values()]
}

/** "Criar contato" só com telefone brasileiro válido ou e-mail — senão é contato de lixo. */
export function canCreateFromAsaas(phone: string | null | undefined, email: string | null | undefined): boolean {
  return !!asaasPhoneForContact(phone) || !!normalizeEmail(email)
}

// ------------------------------------------- "Criar contato" nunca chuta (16/09)
// Devedor AMBÍGUO (2+ contatos com o telefone, o e-mail ou o CPF/CNPJ dele —
// duplicata antiga com e sem o 9º dígito) passava pelo "Criar contato e ligar"
// e pelo "Criar contatos do Asaas" da carteira: findOrCreateContact reaproveita
// o primeiro contato que o banco devolver, e o clique agora grava o vínculo
// cliente do Asaas → contato, que vence o casamento automático nas próximas
// parcelas e no lembrete. O chute virava regra e o caso sumia das pendências
// sem ninguém ter escolhido. No painel, o retrato pode ser de horas atrás: um
// duplicado criado depois da leitura deixava o cartão "sem contato".

/** A mesma recusa na carteira (individual e em massa) e no painel "A vencer sem contato". */
export const CREATE_AMBIGUOUS_ERROR =
  'Já existe mais de um contato com o telefone, o e-mail ou o CPF/CNPJ deste cliente. Use "Ligar a um contato" e escolha o certo — criar outro só piora.'

export const CREATE_CHECK_FAILED_ERROR = 'Não deu para conferir agora se já existe contato com estes dados. Tente de novo.'

/**
 * Pode criar? `probe` é o casamento da sincronização SEM o vínculo (findContact
 * com as chaves de `createProbeKeys`), feito na hora do clique; null = a
 * conferência falhou — aí recusa: criar às cegas é o chute que isto evita.
 */
export function createRefusal(probe: { ambiguous: boolean } | null): string | null {
  if (!probe) return CREATE_CHECK_FAILED_ERROR
  return probe.ambiguous ? CREATE_AMBIGUOUS_ERROR : null
}

/**
 * Com que chave conferir antes de criar: a MESMA que a criação procura
 * (createOrFindContactFromAsaas) — o telefone quando ele serve para criar;
 * senão, só o e-mail.
 *
 * Revisão 16/09: a conferência olhava telefone, e-mail e CPF/CNPJ juntos, e a
 * criação só um deles. (a) Celular que ninguém tem + e-mail do financeiro em 2
 * contatos: recusava, embora criar fizesse um contato novo dono do número (que
 * casa sozinho dali em diante) — regressão na carteira. (b) Telefone que não
 * serve para criar ("+1…") mas acha 1 contato: "não ambíguo", e a criação ia
 * pelo e-mail com `.limit(1)` entre 2 contatos — o chute que a trava existe
 * para impedir.
 */
export function createProbeKeys(phone: string | null | undefined, email: string | null | undefined): { phone: string | null; email: string | null } {
  const p = asaasPhoneForContact(phone)
  if (p) return { phone: p, email: null }
  return { phone: null, email: normalizeEmail(email) || null }
}

// ------------------------------------ por onde sai o lembrete depois de ligar
// 16/09: o aviso depois de ligar contava só com a ficha — "sem telefone" virava
// promessa de e-mail, e "o lembrete sai na próxima rodada" saía mesmo quando a
// fila ia pular o contato (sem e-mail usável, régua só por WhatsApp, nenhum
// canal de e-mail conectado: "no_channel", só no log). E o cartão já tinha
// sumido da tela. Agora o servidor confere com o MESMO teste da fila do
// lembrete (resolveCollectionTargets em dryRun, com o e-mail do Asaas de
// reserva) e a tela só diz o que vai acontecer.

/** Resultado de resolveCollectionTargets em dryRun — só o que o aviso usa. null = não deu para conferir. */
export type DeliveryCheck = { ok: true; label: string } | { ok: false; error: string } | null

export interface LinkDeliveryInfo {
  contactName: string
  contactHasPhone: boolean
  /** A ficha tem OUTRO telefone que o do Asaas: o lembrete vai para o da ficha. */
  phoneDiffers: boolean
  /** "WhatsApp", "e-mail" ou "WhatsApp e e-mail". null = não sai, ou não deu para conferir. */
  deliveryLabel: string | null
  /** Por que o lembrete NÃO sai para este contato. null = sai, ou não deu para conferir. */
  deliveryError: string | null
}

/** Contato que pediu para não receber (SAIR): a fila do lembrete pula, então o aviso também diz. */
export const OPTED_OUT_DELIVERY_ERROR = 'O contato pediu para não receber mensagens.'

// Revisão 16/09: o aviso depois de ligar espelhava o opt-out e o canal, mas não
// o FREIO do devedor, que a fila confere logo depois (debtorHold: pausa,
// limite de toques, promessa/comprovante). Ligar à ficha da empresa que está
// em "Régua parada" mostrava "O lembrete sai por WhatsApp", a rodada pulava
// calada ("on_hold" só na contagem) e o cartão já tinha sumido.

/** O freio do contato, como a fila lê de collections_touches (`debtorHold` + motivo/data). */
export interface DeliveryHold {
  kind: DebtorHold
  /** Motivo da pausa ou da promessa, quando há. */
  reason?: string | null
  /** Até quando a promessa/comprovante segura (ISO) — só no 'snoozed'. */
  until?: string | null
}

/**
 * Por que o lembrete não sai com o freio ligado. Não reusa `holdRefusal`: ele
 * diz "nada foi enviado", texto de envio que já estava na fila.
 */
export function holdDeliveryError(hold: DeliveryHold, timeZone = 'America/Sao_Paulo'): string {
  const motivo = hold.reason && hold.reason.trim() ? ` (${hold.reason.trim()})` : ''
  // Os nomes dos botões de "Régua parada sem cobrança vencida" (wallet-client).
  if (hold.kind === 'paused') return `A régua está parada neste cliente${motivo} — use "Retomar cobrança" em Cobranças para o lembrete sair.`
  if (hold.kind === 'max_touches') return 'Chegou no limite de cobranças da régua sem resposta — use "Zerar toques" em Cobranças para o lembrete sair.'
  const ms = hold.until ? Date.parse(hold.until) : Number.NaN
  const ate = Number.isNaN(ms) ? '' : ` até ${dayMonthIn(ms, timeZone)}`
  return `A régua está parada neste cliente${ate}${motivo} — enquanto isso, o lembrete não sai.`
}

/** DD/MM no fuso da conta; fuso inválido cai no de São Paulo (padrão da conta). */
function dayMonthIn(ms: number, timeZone: string): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).format(new Date(ms))
  try {
    return fmt(timeZone)
  } catch {
    return fmt('America/Sao_Paulo')
  }
}

export function linkDeliveryInfo(input: {
  contactName: string | null
  contactPhone: string | null
  optedOut: boolean
  /** Telefone do cliente no Asaas (como veio). */
  asaasPhone: string | null
  delivery: DeliveryCheck
  /** Freio do contato (debtorHold). null/ausente = sem freio (ou leitura falhou — aí `delivery` vem null). */
  hold?: DeliveryHold | null
  /** Fuso da conta, para a data da promessa. */
  timeZone?: string
}): LinkDeliveryInfo {
  const digits = (input.contactPhone ?? '').replace(/\D/g, '')
  const asaasTail = (input.asaasPhone ?? '').replace(/\D/g, '').slice(-8)
  const d = input.delivery
  // A mesma ordem da fila: SAIR, depois o freio, depois o canal.
  const blocked = input.optedOut ? OPTED_OUT_DELIVERY_ERROR : input.hold ? holdDeliveryError(input.hold, input.timeZone) : null
  return {
    contactName: (input.contactName ?? '').trim() || (input.contactPhone ?? '').trim() || 'contato sem nome',
    // O mesmo corte da fila (outreach: 10 dígitos ou mais).
    contactHasPhone: digits.length >= 10,
    // Pelos 8 últimos dígitos: com/sem 55 e com/sem o 9º dígito é o mesmo número.
    phoneDiffers: digits.length >= 8 && asaasTail.length === 8 && digits.slice(-8) !== asaasTail,
    deliveryLabel: blocked ? null : d?.ok ? d.label : null,
    deliveryError: blocked ?? (d && !d.ok ? d.error : null),
  }
}

/**
 * O que a tela diz depois de ligar (ou criar): `reminder` completa o aviso de
 * sucesso e `warning`, quando há, vai num aviso à parte. Nunca promete canal
 * que não foi conferido.
 */
export function linkOutcomeTexts(customerName: string, ruleEnabled: boolean, r: LinkDeliveryInfo): { reminder: string; warning: string | null } {
  if (r.deliveryError) {
    return { reminder: '', warning: `O lembrete de ${customerName} NÃO vai sair: ${r.deliveryError}` }
  }
  const label = r.deliveryLabel
  let reminder: string
  if (!ruleEnabled) reminder = reminderAfterLinkText(false)
  else if (label) reminder = `O lembrete sai por ${label} na próxima rodada da régua.`
  // A conferência falhou: não prometo que sai.
  else reminder = 'Não deu para conferir por onde o lembrete sai — confira o telefone e o e-mail da ficha.'

  let warning: string | null = null
  if (!r.contactHasPhone) {
    warning = label
      ? `A ficha de ${r.contactName} não tem telefone: o lembrete não sai por WhatsApp, só por ${label}.`
      : `A ficha de ${r.contactName} não tem telefone: o lembrete não sai por WhatsApp.`
  } else if (r.phoneDiffers && (!label || label.includes('WhatsApp'))) {
    warning = `A ficha de ${r.contactName} tem outro telefone — o lembrete vai para o número da ficha, não para o do Asaas.`
  }
  return { reminder, warning }
}

// ------------------------------------------- "Ligados nos últimos dias" (16/09)
// Ligação errada feita no painel só podia ser desfeita nos 12 s do "Desfazer".
// Depois o cartão sumia, e cliente que só tem parcela A VENCER não aparece na
// carteira (lá só entra cobrança aberta): não havia onde ver nem desligar, e o
// lembrete saía com o valor e o link de um cliente para o contato errado.

/** O lembrete sai até N dias antes do vencimento; uma semana a mais dá tempo de alguém notar a ligação errada. */
export const RECENT_LINK_EXTRA_DAYS = 7
export const RECENT_LINKS_LIMIT = 50

/** Desde quando (ISO) um vínculo conta como "recente". */
export function recentLinksSince(nowMs: number, reminderDaysBefore: number): string {
  const days = Math.max(0, Math.floor(Number(reminderDaysBefore) || 0)) + RECENT_LINK_EXTRA_DAYS
  return new Date(nowMs - days * 86_400_000).toISOString()
}

/** Nome do cliente na lista; vínculo gravado antes da 0179 (ou cadastro sem nome) mostra o cus_. */
export function recentLinkName(customerName: string | null | undefined, customerId: string): string {
  return blankToNull(customerName) ?? `cliente ${customerId} do Asaas`
}

/**
 * Aviso do "Desligar". Desligar só apaga o vínculo: se algum contato (inclusive
 * o que foi desligado) tem o telefone, o e-mail ou o CPF/CNPJ do Asaas, a régua
 * liga a ele de novo sozinha. E o lembrete que já está na fila não é cancelado.
 *
 * Revisão 16/09: o texto mandava só "conferir em Precisa de você" — recusar lá
 * fazia a parcela contar como já lembrada e o contato certo nunca recebia.
 * Agora "já lembrado" é por contato (remindedByContact), e o pedido pending de
 * outro dia já expirou sozinho (stale.ts): o que sobra é o de HOJE.
 */
export function recentUnlinkText(input: { customerName: string; contactName: string; ruleEnabled: boolean }): string {
  const back = input.ruleEnabled ? 'na próxima rodada da régua' : 'quando a régua for religada'
  return (
    `Desligado: ${input.customerName} não está mais ligado a ${input.contactName}. ` +
    `Se nenhum contato tiver o telefone, o e-mail ou o CPF/CNPJ do Asaas, o cliente volta para "A vencer sem contato" ${back}; ` +
    `se algum tiver (inclusive ${input.contactName}), a régua liga a ele sozinha. ` +
    `O lembrete de hoje que ainda estiver na fila para ${input.contactName} não é cancelado: recuse em "Precisa de você" — ` +
    'o contato certo ainda recebe o lembrete quando for ligado. Pedido de outro dia já expirou sozinho.'
  )
}

/** Nome do Asaas que o "Desfazer" do Desligar devolve ao vínculo (volta do navegador: só texto, aparado e com teto). */
export function relinkCustomerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return blankToNull(raw.slice(0, 200))
}

// ------------------------------------------------ "Desfazer" do painel (16/09)
// A primeira versão do desfazer zerava TODA cobrança aberta do cliente que
// estivesse 'manual' no contato do vínculo. Isso apagava ligação feita à mão
// ANTES do clique — na carteira, antes da 0178 (sem vínculo retroativo), ou
// pela IA em emit.ts (nasce 'manual', sem vínculo): a vencida virava "Sem
// contato" e a régua parava de cobrá-la. Agora o clique guarda o estado de
// antes só das linhas que ele MUDA, e o desfazer devolve exatamente essas.

/** Uma cobrança aberta como estava antes do clique. */
export interface ChargeRestore {
  id: string
  contactId: string | null
  matchedBy: string | null
}

/**
 * A cobrança aberta que o "Ligar" do painel pode levar para o contato escolhido:
 * a espelhada do Asaas (origin 'sync') ou a que está sem contato — a MESMA
 * condição do CASE da sincronização (sync.ts).
 *
 * Revisão 16/09: a sincronização passou a deixar a cobrança emitida pelo CRM
 * (IA ou "Nova cobrança", emit.ts grava 'manual') com o contato da conversa,
 * mas o clique de ligar ainda a levava. Sócio C pede a cobrança pela conversa
 * (emit reaproveita cus_X), alguém liga cus_X ao financeiro B no painel: a
 * linha de C virava B/'manual', a sincronização mantinha B e, ao vencer, a
 * régua cobrava quem não pediu — dependia só da ordem dos cliques.
 */
export function linkMayMoveCharge(r: { origin: string | null; contactId: string | null }): boolean {
  return r.origin === 'sync' || !r.contactId
}

/**
 * Das cobranças abertas do cliente, as que ligar a `contactId` muda de fato.
 * A que já está 'manual' neste mesmo contato não é tocada nem entra no
 * desfazer — ela já era assim antes do clique.
 */
export function chargesChangedByLink(rows: readonly ChargeRestore[], contactId: string): ChargeRestore[] {
  return rows
    .filter((r) => r.contactId !== contactId || r.matchedBy !== 'manual')
    .map((r) => ({ id: r.id, contactId: r.contactId ?? null, matchedBy: r.matchedBy ?? null }))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MATCHED_BY_VALUES = new Set(['phone', 'email', 'code', 'manual'])
/** Um cliente do Asaas com mais parcelas abertas que isto não existe na prática — é só o teto contra payload inventado. */
export const MAX_CHARGE_RESTORE = 200

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/**
 * A lista do desfazer volta do NAVEGADOR: só passa o que tem forma de cobrança
 * (id uuid, contato uuid ou nulo, matched_by conhecido ou nulo), sem repetir e
 * com teto. O servidor ainda confere conta, cliente e estado de cada linha.
 */
export function sanitizeChargeRestore(raw: unknown): ChargeRestore[] {
  if (!Array.isArray(raw)) return []
  const out = new Map<string, ChargeRestore>()
  for (const item of raw) {
    if (out.size >= MAX_CHARGE_RESTORE) break
    if (!item || typeof item !== 'object') continue
    const { id, contactId, matchedBy } = item as Record<string, unknown>
    if (!isUuid(id)) continue
    out.set(id, {
      id,
      contactId: isUuid(contactId) ? contactId : null,
      matchedBy: typeof matchedBy === 'string' && MATCHED_BY_VALUES.has(matchedBy) ? matchedBy : null,
    })
  }
  return [...out.values()]
}

/** Contato de antes que sumiu da conta no meio: a cobrança volta sem contato, para o casamento automático tentar. */
export function restoreTarget(item: ChargeRestore, existingContactIds: ReadonlySet<string>): { contactId: string | null; matchedBy: string | null } {
  if (item.contactId && !existingContactIds.has(item.contactId)) return { contactId: null, matchedBy: null }
  return { contactId: item.contactId, matchedBy: item.matchedBy }
}

/** O que prende o contato que o "Criar contato" acabou de criar (lido depois de desfazer vínculo e cobranças). */
export interface CreatedContactDeps {
  /** Criado há pouco (o desfazer vive 12 s no toast; a folga é de minutos). */
  recent: boolean
  /** Quem desfaz é quem criou — o id do contato volta do navegador. */
  createdByUser: boolean
  conversations: boolean
  deals: boolean
  /** Outro cliente do Asaas ligado a ele. */
  links: boolean
  /** Cobrança (de qualquer cliente) ainda apontando para ele. */
  charges: boolean
  /** Lembrete/cobrança já na fila para ele. */
  actionRequests: boolean
  /** Nota ou tarefa. */
  notes: boolean
  /** Etiqueta. */
  tags: boolean
  /** Mensagem agendada ou evento na agenda. */
  schedule: boolean
  /** Régua (collections_touches) ou compra registrada (customer_transactions). */
  history: boolean
}

/**
 * 16/09: desfazer o "Criar contato" apagando só o vínculo não desfazia nada —
 * o contato criado tem o telefone/e-mail do Asaas e a leitura seguinte casava
 * sozinha com ele (o cartão nunca voltava). O contato sai junto quando acabou
 * de nascer, foi quem desfaz que criou e nada depende dele; senão fica, e a
 * tela diz a verdade. Só um `false` claro conta como "sem uso": o apagar é em
 * cascata (nota, etiqueta, régua e fila iriam junto).
 */
export function canRemoveCreatedContact(d: CreatedContactDeps | null): boolean {
  if (!d || d.recent !== true || d.createdByUser !== true) return false
  return [d.conversations, d.deals, d.links, d.charges, d.actionRequests, d.notes, d.tags, d.schedule, d.history].every((v) => v === false)
}

/** Quando o lembrete sai depois de ligar — com a régua desligada, a "próxima rodada" não vem. */
export function reminderAfterLinkText(ruleEnabled: boolean): string {
  return ruleEnabled ? 'O lembrete sai na próxima rodada da régua.' : 'A régua está desligada: o lembrete só sai quando ela for religada.'
}

/** linked = "Ligar a um contato" · created = "Criar contato" criou · existing = "Criar contato" achou um que já existia. */
export type UpcomingUndoKind = 'linked' | 'created' | 'existing'

/** O toast do "Desfazer" — nunca promete que o cartão volta quando o contato vai casar sozinho de novo. */
export function undoResultText(input: { kind: UpcomingUndoKind; contactRemoved: boolean; contactName: string; ruleEnabled: boolean }): string {
  const back = input.ruleEnabled ? 'o cliente volta para a lista na próxima rodada da régua' : 'o cliente volta para a lista quando a régua for religada'
  const name = input.contactName.trim() || 'contato'
  if (input.kind === 'linked') return `Desfeito: ${back}.`
  if (input.kind === 'created' && input.contactRemoved) return `Desfeito: o contato criado foi apagado e ${back}.`
  if (input.kind === 'created') {
    return `Vínculo desfeito, mas o contato "${name}" continua no CRM (já tem conversa, negócio ou outra cobrança) com o telefone ou o e-mail do Asaas — a régua vai casar com ele de novo. Se foi engano, apague esse contato ou corrija o telefone e o e-mail dele.`
  }
  return `Vínculo desfeito, mas o contato "${name}" já existia com o mesmo telefone ou e-mail do Asaas — a régua vai continuar casando com ele. Se não é este cliente, corrija o telefone ou o e-mail desse contato.`
}

/**
 * Toast do "desligar contato" da carteira. 16/09: prometia que as próximas
 * parcelas deixavam de ir para o contato, mas desligar só apaga o vínculo —
 * quando o casamento era automático (telefone, e-mail ou CPF/CNPJ), a
 * sincronização seguinte liga de novo ao MESMO contato.
 */
export function unlinkDebtorText(matchedBy: string | null | undefined): string {
  const base = 'Contato desligado — voltou para as pendências.'
  if (matchedBy === 'manual') {
    return `${base} A próxima sincronização só liga de novo se o telefone, o e-mail ou o CPF/CNPJ do Asaas for o desta ficha.`
  }
  return `${base} Ele foi ligado pelo telefone, e-mail ou CPF/CNPJ do Asaas, então a próxima sincronização liga de novo. Para não voltar, corrija o cadastro no Asaas ou a ficha do contato.`
}

export function unmatchedReasonText(reason: UnmatchedReason): string {
  // decideMatch também empata por e-mail ou CPF/CNPJ quando o telefone não
  // achou ninguém — "com este telefone" mentia nesses casos (16/09).
  return reason === 'ambiguous'
    ? 'Mais de um contato do CRM com o mesmo telefone, e-mail ou CPF/CNPJ — escolha o certo'
    : 'Nenhum contato do CRM com este telefone, e-mail ou CPF/CNPJ'
}

/** "vence hoje" · "vence amanhã" · "vence em 3 dias" (datas no fuso da conta). */
export function dueInText(dueDate: string | null, todayKey: string): string {
  if (!dueDate) return 'sem vencimento'
  const d = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`)
  const t = Date.parse(`${todayKey.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(d) || Number.isNaN(t)) return 'sem vencimento'
  const n = Math.round((d - t) / 86_400_000)
  if (n < 0) return 'já venceu'
  if (n === 0) return 'vence hoje'
  if (n === 1) return 'vence amanhã'
  return `vence em ${n} dias`
}

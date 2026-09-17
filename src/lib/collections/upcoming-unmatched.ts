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

/** (conexão, cliente) sem repetição, ignorando cobrança sem cliente do Asaas. */
export function uniqueCustomerRefs(list: readonly { connectionId: string; asaasCustomerId: string | null }[]): UnmatchedCustomerRef[] {
  const seen = new Map<string, UnmatchedCustomerRef>()
  for (const r of list) {
    if (!r.asaasCustomerId) continue
    const ref = { connectionId: r.connectionId, customerId: r.asaasCustomerId }
    seen.set(customerRefKey(ref), ref)
  }
  return [...seen.values()]
}

/** "Criar contato" só com telefone brasileiro válido ou e-mail — senão é contato de lixo. */
export function canCreateFromAsaas(phone: string | null | undefined, email: string | null | undefined): boolean {
  return !!asaasPhoneForContact(phone) || !!normalizeEmail(email)
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
  conversations: boolean
  deals: boolean
  /** Outro cliente do Asaas ligado a ele. */
  links: boolean
  /** Cobrança (de qualquer cliente) ainda apontando para ele. */
  charges: boolean
  /** Lembrete/cobrança já na fila para ele. */
  actionRequests: boolean
}

/**
 * 16/09: desfazer o "Criar contato" apagando só o vínculo não desfazia nada —
 * o contato criado tem o telefone/e-mail do Asaas e a leitura seguinte casava
 * sozinha com ele (o cartão nunca voltava). O contato sai junto quando acabou
 * de nascer e nada depende dele; senão fica, e a tela diz a verdade.
 */
export function canRemoveCreatedContact(d: CreatedContactDeps | null): boolean {
  return !!d && d.recent && !d.conversations && !d.deals && !d.links && !d.charges && !d.actionRequests
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

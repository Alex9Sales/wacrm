// ============================================================
// 🧾 Cadastros órfãos no Asaas do cliente: inventário e limpeza (16/09).
//
// Antes do 177f422e (15/09 19:02) o CRM criava o cliente no Asaas SEM CPF/CNPJ
// e o POST /payments de produção recusava: sobrava um cadastro órfão (caso do
// Alex na FluxiaCRM, 08/09 14:48). Hoje não nasce mais; o Alex autorizou limpar.
// A decisão fica em lib/asaas/orphans.ts (pura, testada) e as chamadas de
// apagar/restaurar em lib/asaas/customer-admin.ts (o app não importa).
//
// DRY-RUN POR PADRÃO. Saída em JSON Lines no stdout (uma linha por cadastro
// relevante, as ações e um resumo no fim); avisos para gente no stderr.
// Rode DENTRO do container web (tem DATABASE_URL e ENCRYPTION_KEY) e mande o
// stdout para um arquivo NO HOST: o container é recriado a cada deploy.
//
//   npx tsx src/scripts/asaas-orphans.ts                                    inventário, todas as conexões de produção
//   npx tsx src/scripts/asaas-orphans.ts --connection <uuid>                inventário de uma conexão
//   npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --delete cus_a,cus_b          reconfere ao vivo e SIMULA
//   npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --delete cus_a,cus_b --apply  apaga
//   npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --restore cus_a --apply       desfaz
//   npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --set-document cus_a --doc <cpf/cnpj> [--apply]
//
// Classes: A = cadastro do CRM sem documento (só ela vira ação);
//          B = cadastro do CRM duplicado (documento repetido noutro cadastro);
//          C = cadastro do CRM com documento diferente do confirmado.
// B e C são SÓ relatório: quem resolve é o dono, no painel do Asaas.
//
// Nunca imprime chave nem header. CPF/CNPJ sai mascarado. A saída tem nome do
// cliente e id de contato (dado pessoal): não colar em canal público.
// ============================================================

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import { db, asaasCharges, asaasConnections, contactCustomValues, contacts, customFields, organizationBilling } from '@/db'
import {
  AsaasApiError,
  findCustomerByDocument,
  updateCustomerDocument,
  type AsaasCredential,
  type AsaasCustomer,
  type AsaasEnv,
} from '@/lib/asaas/collections'
import { countCustomerLinks, deleteCustomer, getCustomerRaw, listCustomersStrict, restoreCustomer } from '@/lib/asaas/customer-admin'
import { normalizeDocument } from '@/lib/asaas/match'
import {
  classifyCrmDuplicate,
  classifyOrphan,
  classifySuspiciousDocument,
  confirmedDocumentsOf,
  crmReferenceOf,
  decideSetDocument,
  isCrmOrphanCandidate,
  maskDigits,
  parseOrphanArgs,
  pickKnownDocument,
  safeToDelete,
  type OrphanDecision,
  type OrphanFacts,
  type ReportDecision,
  type WalletDocRow,
} from '@/lib/asaas/orphans'
import { decrypt } from '@/lib/whatsapp/encryption'

/** 200 páginas × 100 = 20 mil cadastros. Passou disso a conexão é abortada: nunca seguir com lista parcial. */
const MAX_PAGES = 200
/** Ids por consulta ao banco (inArray vira um parâmetro por id). */
const CHUNK = 500

const USAGE = `uso:
  npx tsx src/scripts/asaas-orphans.ts [--connection <uuid>]
  npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --delete cus_a[,cus_b] [--apply]
  npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --restore cus_a[,cus_b] [--apply]
  npx tsx src/scripts/asaas-orphans.ts --connection <uuid> --set-document cus_a --doc <cpf/cnpj> [--apply]
sem --apply nada é escrito no Asaas.`

type Conn = typeof asaasConnections.$inferSelect

interface Prepared {
  conn: Conn
  /** null = a chave não decifrou (a conexão é pulada e a rodada sai com 1). */
  cred: AsaasCredential | null
}

interface Listing {
  customers: AsaasCustomer[]
  complete: boolean
  error: string | null
}

type ContactPlace = 'same_account' | 'same_asaas_other_account' | 'other_account' | 'missing'

interface InventoryItem {
  customer: AsaasCustomer
  klass: 'A' | 'B' | 'C' | 'B+C'
  ref: string
  /** Só na classe A. */
  facts: OrphanFacts | null
  decision: OrphanDecision | ReportDecision
}

interface Summary {
  connections: number
  aborted: string[]
  customersScanned: number
  byClass: Record<string, number>
  byVerdict: Record<string, number>
  actions: Record<string, number>
}

// ---------------------------------------------------------------- saída

// Chaves decifradas: só em memória. Tudo que sai passa pelo scrub, por garantia.
const secrets: string[] = []

function scrub(text: string): string {
  let out = text
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***')
  return out
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(`${scrub(JSON.stringify(obj))}\n`)
}

function say(msg: string): void {
  process.stderr.write(`${scrub(msg)}\n`)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** Foto do cadastro antes de escrever: tudo que o GET devolveu, com o documento mascarado. */
function snapshotOf(c: AsaasCustomer & Record<string, unknown>): Record<string, unknown> {
  return { ...c, cpfCnpj: (c.cpfCnpj ?? '').trim() ? maskDigits(c.cpfCnpj) : (c.cpfCnpj ?? null) }
}

// ---------------------------------------------------------------- banco (só leitura)

/** id do contato (minúsculo) → conta. Contato é UUID global: procura em TODAS as contas. */
async function contactAccounts(refs: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const unique = [...new Set(refs)]
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK)
    const rows = await db.select({ id: contacts.id, accountId: contacts.accountId }).from(contacts).where(inArray(contacts.id, part))
    for (const r of rows) map.set(r.id.toLowerCase(), r.accountId)
  }
  return map
}

/** Linhas da carteira com documento por contato, da mais nova para a mais antiga. */
async function walletRowsByContact(contactIds: string[]): Promise<Map<string, WalletDocRow[]>> {
  const map = new Map<string, WalletDocRow[]>()
  const unique = [...new Set(contactIds)]
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK)
    const rows = await db
      .select({ contactId: asaasCharges.contactId, cpfCnpj: asaasCharges.cpfCnpj, origin: asaasCharges.origin, matchedBy: asaasCharges.matchedBy })
      .from(asaasCharges)
      .where(and(inArray(asaasCharges.contactId, part), isNotNull(asaasCharges.cpfCnpj)))
      .orderBy(desc(asaasCharges.createdAt))
    for (const r of rows) {
      if (!r.contactId) continue
      const key = r.contactId.toLowerCase()
      map.set(key, [...(map.get(key) ?? []), { cpfCnpj: r.cpfCnpj, origin: r.origin, matchedBy: r.matchedBy }])
    }
  }
  return map
}

/** CPF/CNPJ no campo personalizado do contato (mesma regra do emit.ts, sem importar o emit e suas filas). */
async function customFieldDocument(accountId: string, contactId: string): Promise<string | null> {
  const rows = await db
    .select({ value: contactCustomValues.value })
    .from(contactCustomValues)
    .innerJoin(customFields, eq(customFields.id, contactCustomValues.customFieldId))
    .where(
      and(
        eq(contactCustomValues.contactId, contactId),
        eq(customFields.accountId, accountId),
        sql`${customFields.fieldName} ~* '(cpf|cnpj|documento)'`,
      ),
    )
    .limit(3)
  for (const r of rows) {
    const d = normalizeDocument(r.value)
    if (d) return d
  }
  return null
}

/** O que o CRM tem apontando para o cadastro: linhas da carteira (qualquer conta) e a nossa assinatura. */
async function localLinks(customerId: string): Promise<{ localCharges: number; isBillingCustomer: boolean }> {
  const [charges] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(asaasCharges)
    .where(eq(asaasCharges.asaasCustomerId, customerId))
  const billing = await db
    .select({ id: organizationBilling.organizationId })
    .from(organizationBilling)
    .where(eq(organizationBilling.asaasCustomerId, customerId))
    .limit(1)
  return { localCharges: Number(charges?.n ?? 0), isBillingCustomer: billing.length > 0 }
}

// ---------------------------------------------------------------- contas ligadas ao mesmo Asaas

/**
 * Contas do CRM que usam ESTE Asaas: a da conexão e as que têm conexão de
 * produção com a mesma chave. Um contato de outra conta sem essa chave não
 * prova que o cadastro é nosso: vira revisão, nunca remoção.
 */
function sameAsaasAccounts(p: Prepared, all: Prepared[]): Set<string> {
  const set = new Set<string>([p.conn.accountId])
  if (!p.cred) return set
  for (const o of all) if (o.cred && o.cred.apiKey === p.cred.apiKey) set.add(o.conn.accountId)
  return set
}

function placeOf(ref: string, conn: Conn, contactMap: Map<string, string>, sameAsaas: Set<string>): ContactPlace {
  const acc = contactMap.get(ref)
  if (!acc) return 'missing'
  if (acc === conn.accountId) return 'same_account'
  return sameAsaas.has(acc) ? 'same_asaas_other_account' : 'other_account'
}

// ---------------------------------------------------------------- inventário

async function listConnection(p: Prepared): Promise<Listing> {
  if (!p.cred) return { customers: [], complete: false, error: 'não deu para decifrar a chave desta conexão' }
  try {
    const r = await listCustomersStrict(p.cred, MAX_PAGES)
    return { customers: r.customers, complete: r.complete, error: null }
  } catch (err) {
    return { customers: [], complete: false, error: errText(err) }
  }
}

function activeByDocument(customers: readonly AsaasCustomer[]): Map<string, AsaasCustomer[]> {
  const map = new Map<string, AsaasCustomer[]>()
  for (const c of customers) {
    if (c.deleted === true) continue
    const d = normalizeDocument(c.cpfCnpj)
    if (d) map.set(d, [...(map.get(d) ?? []), c])
  }
  return map
}

async function inventoryOf(
  p: Prepared,
  listing: Listing,
  all: Prepared[],
  listings: Map<string, Listing>,
  summary: Summary,
): Promise<Map<string, InventoryItem>> {
  const cred = p.cred as AsaasCredential
  const conn = p.conn
  const items = new Map<string, InventoryItem>()
  const customers = listing.customers
  summary.customersScanned += customers.length

  const withRef = customers.filter((c) => c.deleted !== true && crmReferenceOf(c))
  const contactMap = await contactAccounts(withRef.map((c) => crmReferenceOf(c) as string))
  const sameAsaas = sameAsaasAccounts(p, all)
  const existingRefs = withRef.map((c) => crmReferenceOf(c) as string).filter((ref) => sameAsaas.has(contactMap.get(ref) ?? ''))
  const wallet = await walletRowsByContact(existingRefs)
  const byDoc = activeByDocument(customers)

  // Conexões da mesma conta com lista completa: onde o cliente pode já existir com documento.
  const siblings = all.filter((o) => o.conn.id !== conn.id && o.conn.accountId === conn.accountId && listings.get(o.conn.id)?.complete)

  for (const c of withRef) {
    const ref = crmReferenceOf(c) as string
    const place = placeOf(ref, conn, contactMap, sameAsaas)
    const contactExists = place === 'same_account' || place === 'same_asaas_other_account'
    const rows = wallet.get(ref) ?? []
    const base = {
      type: 'customer',
      connectionId: conn.id,
      connectionLabel: conn.label,
      connectionEnabled: conn.enabled,
      accountId: conn.accountId,
      customerId: c.id,
      name: c.name ?? null,
      externalReference: ref,
      dateCreated: c.dateCreated ?? null,
      contact: place,
    }

    if (isCrmOrphanCandidate(c)) {
      const local = await localLinks(c.id)
      const contactAccount = contactMap.get(ref)
      const customField = contactExists && contactAccount ? await customFieldDocument(contactAccount, ref) : null
      const known = pickKnownDocument({ rows, customField })
      const docTakenBy = known.doc ? ((byDoc.get(known.doc) ?? []).find((x) => x.id !== c.id)?.id ?? null) : null
      const validElsewhere = docTakenBy ? [`${conn.label}:${docTakenBy}`] : []
      if (known.doc) {
        for (const s of siblings) {
          const hit = activeByDocument(listings.get(s.conn.id)?.customers ?? []).get(known.doc)?.[0]
          if (hit) validElsewhere.push(`${s.conn.label}:${hit.id}`)
        }
      }
      const links = await countCustomerLinks(cred, c.id)
      const facts: OrphanFacts = {
        ...links,
        contactExists,
        localCharges: local.localCharges,
        isBillingCustomer: local.isBillingCustomer,
        knownDoc: known.doc,
        knownDocSource: known.source,
        docTakenBy,
        validElsewhere,
      }
      const decision = classifyOrphan(facts)
      items.set(c.id, { customer: c, klass: 'A', ref, facts, decision })
      bump(summary.byClass, 'A')
      bump(summary.byVerdict, decision.verdict)
      emit({
        ...base,
        class: 'A',
        verdict: decision.verdict,
        reason: decision.reason,
        payments: facts.payments,
        subscriptions: facts.subscriptions,
        invoices: facts.invoices,
        localCharges: facts.localCharges,
        billingCustomer: facts.isBillingCustomer,
        knownDoc: facts.knownDoc ? maskDigits(facts.knownDoc) : null,
        knownDocSource: facts.knownDocSource,
        docTakenBy: facts.docTakenBy,
        validElsewhere: facts.validElsewhere,
      })
      continue
    }

    const dup = classifyCrmDuplicate(c, contactExists, customers)
    const odd = classifySuspiciousDocument(c, contactExists, confirmedDocumentsOf(rows))
    if (!dup && !odd) continue
    const klass = dup && odd ? 'B+C' : dup ? 'B' : 'C'
    const decision: ReportDecision = { verdict: 'report', reason: [dup?.reason, odd?.reason].filter(Boolean).join(' | ') }
    items.set(c.id, { customer: c, klass, ref, facts: null, decision })
    bump(summary.byClass, klass)
    bump(summary.byVerdict, 'report')
    emit({
      ...base,
      class: klass,
      verdict: 'report',
      reason: decision.reason,
      document: maskDigits(c.cpfCnpj),
      duplicates: dup?.others ?? [],
    })
  }
  return items
}

// ---------------------------------------------------------------- ações

function actionLine(p: Prepared, action: string, customerId: string, result: string, extra: Record<string, unknown> = {}): void {
  emit({ type: 'action', action, connectionId: p.conn.id, connectionLabel: p.conn.label, customerId, result, ...extra })
}

/**
 * Apaga só o que o inventário DESTA rodada marcou como 'delete' e que, AO VIVO,
 * continua órfão, com o mesmo ref e zero cobranças, assinaturas e notas.
 */
async function runDelete(p: Prepared, items: Map<string, InventoryItem>, ids: string[], apply: boolean, all: Prepared[], summary: Summary): Promise<boolean> {
  const cred = p.cred as AsaasCredential
  let ok = true
  for (const id of ids) {
    const item = items.get(id)
    if (!item || item.klass !== 'A' || !item.facts) {
      // Rodar o --apply de novo com o mesmo id não é erro: o removido some da listagem.
      const already = await getCustomerRaw(cred, id).then(
        (c) => c.deleted === true,
        () => false,
      )
      if (already) {
        actionLine(p, 'delete', id, 'already_deleted', { reason: 'o Asaas já mostra deleted:true' })
        bump(summary.actions, 'already_deleted')
        continue
      }
      actionLine(p, 'delete', id, 'refused', { reason: 'não aparece como órfão (classe A) no inventário desta conexão agora' })
      bump(summary.actions, 'refused')
      ok = false
      continue
    }
    if (item.decision.verdict !== 'delete') {
      actionLine(p, 'delete', id, 'refused', { reason: `inventário: ${item.decision.verdict} (${item.decision.reason})` })
      bump(summary.actions, 'refused')
      ok = false
      continue
    }

    let fresh: AsaasCustomer & Record<string, unknown>
    try {
      fresh = await getCustomerRaw(cred, id)
    } catch (err) {
      actionLine(p, 'delete', id, 'failed', { reason: `conferência ao vivo falhou: ${errText(err)}` })
      bump(summary.actions, 'failed')
      ok = false
      continue
    }
    if (fresh.deleted === true) {
      actionLine(p, 'delete', id, 'already_deleted', { reason: 'o Asaas já mostra deleted:true' })
      bump(summary.actions, 'already_deleted')
      continue
    }

    const links = await countCustomerLinks(cred, id)
    const local = await localLinks(id)
    const contactMap = await contactAccounts([item.ref])
    const contactExists = sameAsaasAccounts(p, all).has(contactMap.get(item.ref) ?? '')
    const again = classifyOrphan({ ...item.facts, ...links, ...local, contactExists })
    const counts = { payments: links.payments, subscriptions: links.subscriptions, invoices: links.invoices, localCharges: local.localCharges }

    if (!safeToDelete(fresh, item.ref, links) || again.verdict !== 'delete') {
      const reason = !isCrmOrphanCandidate(fresh)
        ? 'o cadastro ganhou documento depois do inventário (foi adotado?)'
        : crmReferenceOf(fresh) !== item.ref
          ? 'externalReference mudou depois do inventário'
          : again.verdict !== 'delete'
            ? again.reason
            : 'contagem ao vivo não deu zero'
      actionLine(p, 'delete', id, 'refused', { reason, ...counts })
      bump(summary.actions, 'refused')
      ok = false
      continue
    }

    emit({ type: 'snapshot', connectionId: p.conn.id, customerId: id, takenAt: new Date().toISOString(), customer: snapshotOf(fresh) })
    if (!apply) {
      actionLine(p, 'delete', id, 'dry_run', { reason: 'removeria (rode de novo com --apply)', ...counts })
      bump(summary.actions, 'dry_run')
      continue
    }

    let body: { deleted: boolean; id: string }
    try {
      body = await deleteCustomer(cred, id)
    } catch (err) {
      actionLine(p, 'delete', id, 'failed', { reason: `DELETE falhou: ${errText(err)}` })
      bump(summary.actions, 'failed')
      ok = false
      continue
    }

    // Confere: o GET seguinte tem que voltar deleted:true. Se o GET falhar, vale o corpo do DELETE.
    let confirmed = body.deleted
    let confirmNote = 'DELETE devolveu deleted:true'
    try {
      const after = await getCustomerRaw(cred, id)
      confirmed = after.deleted === true
      confirmNote = confirmed ? 'GET depois do DELETE mostra deleted:true' : 'GET depois do DELETE NÃO mostra deleted:true'
    } catch (err) {
      confirmNote = `GET de conferência falhou (${errText(err)}); ${body.deleted ? 'DELETE devolveu deleted:true' : 'DELETE não devolveu deleted:true'}`
    }
    const undo = `npx tsx src/scripts/asaas-orphans.ts --connection ${p.conn.id} --restore ${id} --apply`
    actionLine(p, 'delete', id, confirmed ? 'deleted' : 'unconfirmed', { reason: confirmNote, undo, ...counts })
    bump(summary.actions, confirmed ? 'deleted' : 'unconfirmed')
    if (!confirmed) ok = false
  }
  return ok
}

const RESTORE_WARNING =
  'o restore devolve só o cadastro: cobrança ou assinatura apagada junto precisa de restore própria no painel, depois "Atualizar" em Cobranças e conferir asaas_charges.open à mão (o webhook não reabre PAYMENT_RESTORED)'

/** Desfaz o DELETE. Não depende do inventário: desfazer tem que funcionar mesmo com a listagem fora do ar. */
async function runRestore(p: Prepared, ids: string[], apply: boolean, summary: Summary): Promise<boolean> {
  const cred = p.cred as AsaasCredential
  let ok = true
  for (const id of ids) {
    let fresh: (AsaasCustomer & Record<string, unknown>) | null = null
    let note = ''
    try {
      fresh = await getCustomerRaw(cred, id)
    } catch (err) {
      // 404 pode ser o jeito do Asaas mostrar removido: tentar o restore é inofensivo.
      if (!(err instanceof AsaasApiError && err.status === 404)) {
        actionLine(p, 'restore', id, 'failed', { reason: `GET falhou: ${errText(err)}` })
        bump(summary.actions, 'failed')
        ok = false
        continue
      }
      note = 'GET devolveu 404; '
    }
    if (fresh && fresh.deleted !== true) {
      actionLine(p, 'restore', id, 'nothing_to_restore', { reason: 'o cadastro não está removido' })
      bump(summary.actions, 'nothing_to_restore')
      continue
    }
    if (!apply) {
      actionLine(p, 'restore', id, 'dry_run', { reason: `${note}restauraria (rode de novo com --apply)`, warning: RESTORE_WARNING })
      bump(summary.actions, 'dry_run')
      continue
    }
    try {
      await restoreCustomer(cred, id)
    } catch (err) {
      actionLine(p, 'restore', id, 'failed', { reason: `${note}restore falhou: ${errText(err)}` })
      bump(summary.actions, 'failed')
      ok = false
      continue
    }
    let restored = false
    let confirmNote = ''
    try {
      const after = await getCustomerRaw(cred, id)
      restored = after.deleted !== true
      confirmNote = restored ? 'GET depois do restore mostra o cadastro ativo' : 'GET depois do restore ainda mostra deleted:true'
    } catch (err) {
      confirmNote = `GET de conferência falhou: ${errText(err)}`
    }
    actionLine(p, 'restore', id, restored ? 'restored' : 'unconfirmed', { reason: `${note}${confirmNote}`, warning: RESTORE_WARNING })
    bump(summary.actions, restored ? 'restored' : 'unconfirmed')
    if (!restored) ok = false
  }
  return ok
}

/**
 * Grava o documento DIGITADO (--doc) num órfão. Nunca usa documento da carteira
 * sozinho: cobrança casada por telefone pode ser de outra pessoa (15/09).
 */
async function runSetDocument(
  p: Prepared,
  items: Map<string, InventoryItem>,
  listing: Listing,
  id: string,
  doc: string,
  apply: boolean,
  summary: Summary,
): Promise<boolean> {
  const cred = p.cred as AsaasCredential
  const refuse = (reason: string, extra: Record<string, unknown> = {}) => {
    actionLine(p, 'set_document', id, 'refused', { reason, document: maskDigits(doc), ...extra })
    bump(summary.actions, 'refused')
    return false
  }
  const item = items.get(id)
  if (!item || item.klass !== 'A' || !item.facts) return refuse('não aparece como órfão (classe A) no inventário desta conexão agora')

  let fresh: AsaasCustomer & Record<string, unknown>
  try {
    fresh = await getCustomerRaw(cred, id)
  } catch (err) {
    actionLine(p, 'set_document', id, 'failed', { reason: `conferência ao vivo falhou: ${errText(err)}` })
    bump(summary.actions, 'failed')
    return false
  }

  // Quem já tem o documento: a lista desta rodada e, por garantia, a busca ao vivo.
  let takenBy = (activeByDocument(listing.customers).get(doc) ?? []).find((x) => x.id !== id)?.id ?? null
  if (!takenBy) {
    try {
      const hit = await findCustomerByDocument(cred, doc, { timeoutMs: 20_000 })
      if (hit && hit.id !== id) takenBy = hit.id
    } catch (err) {
      return refuse(`não deu para conferir se o documento já existe noutro cadastro: ${errText(err)}`)
    }
  }

  const decision = decideSetDocument({ fresh, expectedRef: item.ref, typedDoc: doc, contactExists: item.facts.contactExists, takenBy })
  if (!decision.ok) return refuse(decision.reason)

  const links = await countCustomerLinks(cred, id)
  emit({ type: 'snapshot', connectionId: p.conn.id, customerId: id, takenAt: new Date().toISOString(), customer: snapshotOf(fresh) })
  if (!apply) {
    actionLine(p, 'set_document', id, 'dry_run', { reason: 'gravaria o documento (rode de novo com --apply)', document: maskDigits(decision.doc), ...links })
    bump(summary.actions, 'dry_run')
    return true
  }

  try {
    await updateCustomerDocument(cred, id, decision.doc)
  } catch (err) {
    actionLine(p, 'set_document', id, 'failed', { reason: `PUT falhou: ${errText(err)}` })
    bump(summary.actions, 'failed')
    return false
  }
  let saved = false
  let confirmNote = ''
  try {
    const after = await getCustomerRaw(cred, id)
    saved = normalizeDocument(after.cpfCnpj) === decision.doc
    confirmNote = saved ? 'GET depois do PUT mostra o documento' : 'GET depois do PUT NÃO mostra o documento'
  } catch (err) {
    confirmNote = `GET de conferência falhou: ${errText(err)}`
  }
  actionLine(p, 'set_document', id, saved ? 'document_set' : 'unconfirmed', { reason: confirmNote, document: maskDigits(decision.doc), ...links })
  bump(summary.actions, saved ? 'document_set' : 'unconfirmed')
  return saved
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const parsed = parseOrphanArgs(process.argv.slice(2))
  if (!parsed.ok) {
    say(`erro: ${parsed.error}`)
    say(USAGE)
    return 1
  }
  if (parsed.help) {
    say(USAGE)
    return 0
  }
  const opts = parsed.options
  const startedAt = new Date().toISOString()
  const summary: Summary = { connections: 0, aborted: [], customersScanned: 0, byClass: {}, byVerdict: {}, actions: {} }

  // Todas as conexões de PRODUÇÃO, ligadas ou não: conexão desligada também guarda órfão.
  const rows = await db.select().from(asaasConnections).where(eq(asaasConnections.environment, 'production'))
  const prepared: Prepared[] = rows.map((conn) => {
    try {
      const apiKey = decrypt(conn.apiKeyEnc)
      if (!apiKey) return { conn, cred: null }
      secrets.push(apiKey)
      return { conn, cred: { apiKey, environment: conn.environment as AsaasEnv } }
    } catch {
      return { conn, cred: null }
    }
  })

  const targets = opts.connectionId ? prepared.filter((p) => p.conn.id === opts.connectionId) : prepared
  if (opts.connectionId && !targets.length) {
    say('erro: conexão não encontrada entre as de produção (sandbox fica de fora)')
    return 1
  }
  if (opts.apply) say('--apply: ESCREVE no Asaas de produção. Cada id é reconferido ao vivo antes.')

  let ok = true
  const finish = () => {
    emit({ type: 'summary', mode: opts.apply ? 'apply' : 'dry_run', action: opts.action.kind, startedAt, finishedAt: new Date().toISOString(), ...summary })
    return ok ? 0 : 1
  }

  if (opts.action.kind === 'restore') {
    const p = targets[0]
    summary.connections = 1
    if (!p.cred) {
      say('erro: não deu para decifrar a chave desta conexão')
      summary.aborted.push(p.conn.id)
      ok = false
      return finish()
    }
    ok = await runRestore(p, opts.action.ids, opts.apply, summary)
    return finish()
  }

  // Lista os alvos e as conexões da mesma conta (para "cadastro válido noutra conexão").
  const accountIds = new Set(targets.map((p) => p.conn.accountId))
  const listings = new Map<string, Listing>()
  for (const p of prepared.filter((x) => accountIds.has(x.conn.accountId))) {
    listings.set(p.conn.id, await listConnection(p))
  }

  for (const p of targets) {
    summary.connections++
    const listing = listings.get(p.conn.id) as Listing
    const header = {
      type: 'connection',
      connectionId: p.conn.id,
      connectionLabel: p.conn.label,
      accountId: p.conn.accountId,
      enabled: p.conn.enabled,
      customers: listing.customers.length,
      complete: listing.complete,
    }
    if (listing.error || !listing.complete) {
      const reason = listing.error ?? `lista cortada em ${listing.customers.length} cadastros (teto de ${MAX_PAGES} páginas): nada é classificado nem escrito`
      emit({ ...header, aborted: true, reason })
      say(`[${p.conn.label}] abortada: ${reason}`)
      summary.aborted.push(p.conn.id)
      ok = false
      continue
    }
    emit({ ...header, aborted: false })

    const items = await inventoryOf(p, listing, prepared, listings, summary)
    if (p.conn.id !== opts.connectionId) continue

    if (opts.action.kind === 'delete') {
      if (!(await runDelete(p, items, opts.action.ids, opts.apply, prepared, summary))) ok = false
    } else if (opts.action.kind === 'set_document') {
      if (!(await runSetDocument(p, items, listing, opts.action.id, opts.action.doc, opts.apply, summary))) ok = false
    }
  }

  // Ação pedida numa conexão abortada: nada foi escrito, e a rodada não pode sair 0.
  if (opts.action.kind !== 'inventory' && opts.connectionId && summary.aborted.includes(opts.connectionId)) {
    say('nenhuma escrita: a conexão pedida foi abortada no inventário')
    ok = false
  }
  return finish()
}

/** process.exit só depois de a saída ir para o arquivo: sem isso o resumo pode se perder num pipe. */
function exitAfterFlush(code: number): void {
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
}

// process.exit de propósito: o pool do Postgres seguraria o processo aberto.
main().then(
  (code) => exitAfterFlush(code),
  (err) => {
    say(`falhou: ${errText(err)}`)
    exitAfterFlush(1)
  },
)

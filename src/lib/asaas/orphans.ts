// ============================================================
// 🧾 Cadastros órfãos no Asaas DO CLIENTE — a decisão, pura (16/09).
//
// Antes do 177f422e (15/09 19:02) o CRM criava o cliente no Asaas SEM CPF/CNPJ
// (POST /customers com externalReference = id do contato) e só depois o POST
// /payments de produção recusava. A cobrança não nascia e o cadastro ficava lá,
// órfão. Caso real: 08/09 14:48, contato do Alex na FluxiaCRM; o cadastro
// verdadeiro dele (com CPF) nasceu 40 s depois por outra via.
//
// Aqui fica só a DECISÃO (sem banco, sem rede), para ser testada. Quem junta os
// fatos e escreve é src/scripts/asaas-orphans.ts. O app não importa nada disto.
//
// Regras que valem mais que a limpeza:
//  - consulta que falhou é null e vai para revisão. NUNCA vira zero;
//  - cadastro com qualquer vínculo (cobrança, assinatura, nota) nunca é
//    apagado: o DELETE do Asaas leva junto cobranças pendentes e assinaturas;
//  - documento só é gravado se veio de gente (digitado ou cobrança confirmada),
//    nunca de cobrança casada por telefone (15/09: CPF do Sérgio Lemes no João).
// Sem 'server-only'.
// ============================================================

import { normalizeValidDocument } from '@/lib/collections/document'

import { normalizeDocument } from './match'

/** O CRM grava o id do contato (UUID) no externalReference; ERP costuma usar código próprio. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Id de cliente do Asaas (cus_000199053973). Nada além disso entra numa URL de escrita. */
export const ASAAS_CUSTOMER_ID_RE = /^cus_[0-9A-Za-z]+$/

export interface OrphanShape {
  id: string
  cpfCnpj?: string | null
  externalReference?: string | null
  deleted?: boolean | null
}

/** O externalReference, quando tem cara de id de contato do CRM (em minúsculas); senão null. */
export function crmReferenceOf(c: Pick<OrphanShape, 'externalReference'>): string | null {
  const ref = (c.externalReference ?? '').trim()
  return UUID_RE.test(ref) ? ref.toLowerCase() : null
}

/**
 * Classe A: cadastro que o CRM criou (ref = UUID) e ficou com o campo de
 * documento VAZIO. Documento estranho (com letras) não é órfão: é de alguém.
 * Se o ref é mesmo de um contato quem diz é o banco, não esta função.
 */
export function isCrmOrphanCandidate(c: OrphanShape): boolean {
  return c.deleted !== true && !(c.cpfCnpj ?? '').trim() && crmReferenceOf(c) !== null
}

/** 3 primeiros e 2 últimos dígitos. Nunca imprimir documento inteiro. */
export function maskDigits(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  if (!d) return '-'
  if (d.length <= 5) return '…'
  return `${d.slice(0, 3)}…${d.slice(-2)}`
}

// ------------------------------------------------------------ documento conhecido

/**
 * De onde veio o documento conhecido do contato:
 *  - typed: digitado por gente no comando (--doc);
 *  - confirmed: cobrança NOSSA (origin ai/manual) ou casada à mão/por código;
 *  - custom_field: campo personalizado do contato;
 *  - phone_match: cobrança sincronizada casada por telefone/e-mail. PODE SER
 *    DE OUTRA PESSOA (15/09, Sérgio Lemes × João): nunca vira PUT.
 */
export type DocSource = 'typed' | 'confirmed' | 'phone_match' | 'custom_field' | null

export interface WalletDocRow {
  cpfCnpj: string | null
  origin: string | null
  matchedBy: string | null
}

/** A linha da carteira foi confirmada por gente (ou nasceu no CRM)? Mesma regra do walletDocumentFor. */
export function isConfirmedChargeRow(r: Pick<WalletDocRow, 'origin' | 'matchedBy'>): boolean {
  return r.origin === 'ai' || r.origin === 'manual' || r.matchedBy === 'manual' || r.matchedBy === 'code'
}

/** Documentos (distintos, só dígitos) das linhas confirmadas. */
export function confirmedDocumentsOf(rows: readonly WalletDocRow[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (!isConfirmedChargeRow(r)) continue
    const d = normalizeDocument(r.cpfCnpj)
    if (d) out.add(d)
  }
  return [...out]
}

/**
 * O documento que o CRM conhece para o contato, com a origem:
 * digitado > cobrança confirmada > campo personalizado > casada por telefone.
 * `rows` já vem da mais nova para a mais antiga. Digitado inválido não cai
 * em silêncio no conhecido: vira doc null (quem digitou precisa corrigir).
 */
export function pickKnownDocument(input: {
  typed?: string | null
  rows?: readonly WalletDocRow[]
  customField?: string | null
}): { doc: string | null; source: DocSource } {
  if ((input.typed ?? '').replace(/\D/g, '')) {
    const typed = normalizeValidDocument(input.typed)
    return typed ? { doc: typed, source: 'typed' } : { doc: null, source: null }
  }
  const rows = input.rows ?? []
  const confirmed = confirmedDocumentsOf(rows)[0]
  if (confirmed) return { doc: confirmed, source: 'confirmed' }
  const field = normalizeDocument(input.customField)
  if (field) return { doc: field, source: 'custom_field' }
  for (const r of rows) {
    const d = normalizeDocument(r.cpfCnpj)
    if (d) return { doc: d, source: 'phone_match' }
  }
  return { doc: null, source: null }
}

// ------------------------------------------------------------ classe A: órfão

/** Contagens AO VIVO no Asaas. null = a consulta falhou (inclusive 429). */
export interface OrphanLinks {
  payments: number | null
  subscriptions: number | null
  invoices: number | null
}

export interface OrphanFacts extends OrphanLinks {
  /** O ref é contato de uma conta do CRM ligada a este Asaas. */
  contactExists: boolean
  /** Linhas em asaas_charges (qualquer conta) apontando para este cadastro. */
  localCharges: number
  /** É o cadastro da NOSSA assinatura Fluxia (organization_billing). */
  isBillingCustomer: boolean
  knownDoc: string | null
  knownDocSource: DocSource
  /** Outro cadastro ATIVO nesta conexão que já tem knownDoc. */
  docTakenBy: string | null
  /** Onde o cliente já existe com documento ("rótulo:cus_…"). Só informação. */
  validElsewhere: string[]
}

export type OrphanVerdict = 'delete' | 'keep_warn' | 'set_document' | 'review' | 'skip' | 'report'

export interface OrphanDecision {
  verdict: OrphanVerdict
  reason: string
}

function unknownLinks(l: OrphanLinks): string[] {
  const out: string[] = []
  if (l.payments === null) out.push('cobranças')
  if (l.subscriptions === null) out.push('assinaturas')
  if (l.invoices === null) out.push('notas fiscais')
  return out
}

function presentLinks(f: OrphanLinks & { localCharges: number }): string[] {
  const out: string[] = []
  if ((f.payments ?? 0) > 0) out.push(`${f.payments} cobrança(s)`)
  if ((f.subscriptions ?? 0) > 0) out.push(`${f.subscriptions} assinatura(s)`)
  if ((f.invoices ?? 0) > 0) out.push(`${f.invoices} nota(s) fiscal(is)`)
  if (f.localCharges > 0) out.push(`${f.localCharges} linha(s) na carteira do CRM`)
  return out
}

/**
 * O que fazer com um cadastro da classe A. Só 'delete' pode virar DELETE, e
 * mesmo assim o script reconfere tudo ao vivo (safeToDelete) logo antes.
 */
export function classifyOrphan(f: OrphanFacts): OrphanDecision {
  if (f.isBillingCustomer) return { verdict: 'skip', reason: 'cadastro da assinatura Fluxia (organization_billing): fora do escopo' }
  if (!f.contactExists) {
    return { verdict: 'review', reason: 'externalReference não é contato de conta ligada a este Asaas (apagado, fundido ou de outro sistema)' }
  }
  const unknown = unknownLinks(f)
  if (unknown.length) return { verdict: 'review', reason: `não deu para contar ${unknown.join(', ')} no Asaas: consulta falhou, não é zero` }

  const links = presentLinks(f)
  if (links.length) {
    const tem = `tem ${links.join(', ')}`
    const doc = normalizeDocument(f.knownDoc)
    if (!doc) return { verdict: 'keep_warn', reason: `${tem} e nenhum documento conhecido: nunca remover, o dono resolve no painel` }
    if (f.knownDocSource !== 'typed' && f.knownDocSource !== 'confirmed') {
      return {
        verdict: 'keep_warn',
        reason: `${tem}; o documento conhecido (${maskDigits(doc)}) veio de ${f.knownDocSource ?? 'origem desconhecida'} e pode ser de outra pessoa: só com --doc digitado`,
      }
    }
    if (f.docTakenBy) {
      return { verdict: 'keep_warn', reason: `${tem} e o documento ${maskDigits(doc)} já está em ${f.docTakenBy}: completar criaria duplicado` }
    }
    return { verdict: 'set_document', reason: `${tem}: completar o documento ${maskDigits(doc)} (${f.knownDocSource}), nunca remover` }
  }

  return {
    verdict: 'delete',
    reason: f.validElsewhere.length
      ? `sem cobrança, assinatura ou nota; cadastro válido: ${f.validElsewhere.join(', ')}`
      : 'sem cobrança, assinatura ou nota, e sem cadastro válido conhecido (o próximo nasce com documento)',
  }
}

/**
 * Última trava antes do DELETE, com o GET e as contagens feitos AGORA. O
 * código atual ainda ADOTA órfão (pickCustomerForReference + PUT do documento):
 * se a IA ou a tela gerou cobrança entre o inventário e o --apply, o cadastro
 * ganhou documento e cobrança, e o DELETE levaria a cobrança junto.
 */
export function safeToDelete(fresh: OrphanShape | null | undefined, expectedRef: string, links: OrphanLinks): boolean {
  if (!fresh) return false
  const ref = crmReferenceOf(fresh)
  return (
    isCrmOrphanCandidate(fresh) &&
    !!ref &&
    ref === expectedRef.trim().toLowerCase() &&
    links.payments === 0 &&
    links.subscriptions === 0 &&
    links.invoices === 0
  )
}

/**
 * Pode gravar o documento DIGITADO (--doc) no órfão? Só se ele continua órfão,
 * com o mesmo ref, o contato existe e nenhum outro cadastro ativo tem o documento.
 */
export function decideSetDocument(input: {
  fresh: OrphanShape | null | undefined
  expectedRef: string
  typedDoc: string | null | undefined
  contactExists: boolean
  /** Outro cadastro ativo com esse documento (inventário ou busca ao vivo). */
  takenBy: string | null
}): { ok: true; doc: string } | { ok: false; reason: string } {
  const doc = normalizeValidDocument(input.typedDoc)
  if (!doc) return { ok: false, reason: 'documento digitado não é CPF/CNPJ válido' }
  const f = input.fresh
  if (!f) return { ok: false, reason: 'cadastro não encontrado no Asaas' }
  if (f.deleted === true) return { ok: false, reason: 'cadastro está removido no Asaas' }
  if ((f.cpfCnpj ?? '').trim()) return { ok: false, reason: 'cadastro já tem documento (mudou depois do inventário?)' }
  if (crmReferenceOf(f) !== input.expectedRef.trim().toLowerCase()) return { ok: false, reason: 'externalReference mudou depois do inventário' }
  if (!input.contactExists) return { ok: false, reason: 'externalReference não é contato de conta ligada a este Asaas' }
  if (input.takenBy && input.takenBy !== f.id) return { ok: false, reason: `o documento já está em ${input.takenBy}: gravar criaria duplicado` }
  return { ok: true, doc }
}

// ------------------------------------------------------------ classes B e C: só relatório

export interface ReportDecision {
  verdict: 'report'
  reason: string
}

/**
 * Classe B: cadastro do CRM (ref de contato) COM documento, e outro cadastro
 * ATIVO na mesma conexão, sem esse ref, com o mesmo documento. Nasceu entre
 * e92ced7c (08/09) e 177f422e (15/09): a busca por ref (limit 1) achava o órfão
 * e fazia PUT do documento mesmo quando já existia o cadastro verdadeiro (caso
 * João/GoLink). Hoje é duplicado. Nunca apagar sozinho: pode ter cobrança.
 */
export function classifyCrmDuplicate(
  c: OrphanShape,
  contactExists: boolean,
  sameConnection: readonly OrphanShape[],
): (ReportDecision & { others: string[] }) | null {
  if (c.deleted === true || !contactExists) return null
  const ref = crmReferenceOf(c)
  const doc = normalizeDocument(c.cpfCnpj)
  if (!ref || !doc) return null
  const others = sameConnection
    .filter((x) => x.id !== c.id && x.deleted !== true && normalizeDocument(x.cpfCnpj) === doc && crmReferenceOf(x) !== ref)
    .map((x) => x.id)
  if (!others.length) return null
  return {
    verdict: 'report',
    reason: `documento ${maskDigits(doc)} também está em ${others.join(', ')}: cadastro do CRM virou duplicado, o dono decide no painel`,
    others,
  }
}

/**
 * Classe C: cadastro do CRM com documento DIFERENTE de todos os confirmados
 * para o contato. O knownDocumentFor antigo (30474b47) pegava o CPF de
 * qualquer linha da carteira, inclusive casada por telefone, e podia criar o
 * cadastro com o documento de outra pessoa. Sem confirmado, não há o que comparar.
 */
export function classifySuspiciousDocument(
  c: OrphanShape,
  contactExists: boolean,
  confirmedDocs: readonly string[],
): ReportDecision | null {
  if (c.deleted === true || !contactExists) return null
  const doc = normalizeDocument(c.cpfCnpj)
  if (!crmReferenceOf(c) || !doc) return null
  const confirmed = [...new Set(confirmedDocs.map((d) => normalizeDocument(d)).filter(Boolean))]
  if (!confirmed.length || confirmed.includes(doc)) return null
  return {
    verdict: 'report',
    reason: `documento ${maskDigits(doc)} diferente do confirmado para o contato (${confirmed.map(maskDigits).join(', ')}): pode ser de outra pessoa`,
  }
}

// ------------------------------------------------------------ linha de comando

export type OrphanAction =
  | { kind: 'inventory' }
  | { kind: 'delete'; ids: string[] }
  | { kind: 'restore'; ids: string[] }
  | { kind: 'set_document'; id: string; doc: string }

export interface OrphanCliOptions {
  connectionId: string | null
  apply: boolean
  action: OrphanAction
}

export type ParsedOrphanArgs = { ok: true; help: true } | { ok: true; help: false; options: OrphanCliOptions } | { ok: false; error: string }

const KNOWN_FLAGS = new Set(['--connection', '--apply', '--delete', '--restore', '--set-document', '--doc', '--help', '-h'])
const VALUE_FLAGS = new Set(['--connection', '--delete', '--restore', '--set-document', '--doc'])

/**
 * Lê os argumentos ANTES de qualquer banco ou chamada ao Asaas. Tudo que é
 * ambíguo vira erro (flag desconhecida, "--aply" digitado errado, id fora do
 * formato): numa limpeza, erro de digitação não pode virar escrita.
 */
export function parseOrphanArgs(argv: readonly string[]): ParsedOrphanArgs {
  const values = new Map<string, string>()
  let apply = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!KNOWN_FLAGS.has(a)) return { ok: false, error: `argumento desconhecido: ${a}` }
    if (a === '--help' || a === '-h') return { ok: true, help: true }
    if (a === '--apply') {
      apply = true
      continue
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('-')) return { ok: false, error: `${a} precisa de um valor` }
      if (values.has(a)) return { ok: false, error: `${a} repetido` }
      values.set(a, v.trim())
      i++
    }
  }

  const connectionId = values.get('--connection') ?? null
  if (connectionId !== null && !UUID_RE.test(connectionId)) return { ok: false, error: '--connection precisa ser o uuid da conexão' }

  const actions = ['--delete', '--restore', '--set-document'].filter((f) => values.has(f))
  if (actions.length > 1) return { ok: false, error: `uma ação por vez (${actions.join(' e ')})` }
  if (values.has('--doc') && actions[0] !== '--set-document') return { ok: false, error: '--doc só vale com --set-document' }
  if (!actions.length) {
    if (apply) return { ok: false, error: '--apply exige --connection e uma ação (--delete, --restore ou --set-document)' }
    return { ok: true, help: false, options: { connectionId, apply: false, action: { kind: 'inventory' } } }
  }
  if (!connectionId) return { ok: false, error: `${actions[0]} exige --connection <uuid>` }

  const ids = [...new Set((values.get(actions[0]) ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
  if (!ids.length) return { ok: false, error: `${actions[0]} precisa de pelo menos um id cus_…` }
  const bad = ids.find((id) => !ASAAS_CUSTOMER_ID_RE.test(id))
  if (bad) return { ok: false, error: `id fora do formato cus_…: ${bad}` }

  if (actions[0] === '--set-document') {
    if (ids.length !== 1) return { ok: false, error: '--set-document aceita um id por vez' }
    const typed = values.get('--doc')
    if (!typed) return { ok: false, error: '--set-document exige --doc <cpf/cnpj> digitado' }
    const doc = normalizeValidDocument(typed)
    if (!doc) return { ok: false, error: '--doc não é CPF/CNPJ válido' }
    return { ok: true, help: false, options: { connectionId, apply, action: { kind: 'set_document', id: ids[0], doc } } }
  }
  const action: OrphanAction = actions[0] === '--delete' ? { kind: 'delete', ids } : { kind: 'restore', ids }
  return { ok: true, help: false, options: { connectionId, apply, action } }
}

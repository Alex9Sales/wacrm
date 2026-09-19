// ============================================================
// 🧾 Casamento cobrança ↔ contato do CRM (agente de cobrança, Fase 1).
//
// Regra que vale mais que a taxa de acerto: **nunca chutamos**. Se o telefone
// da cobrança bate com dois contatos diferentes, a cobrança fica SEM contato e
// aparece como pendência na tela, para uma pessoa resolver. Cobrar a pessoa
// errada não é um erro de precisão, é uma ligação constrangedora.
//
// Parte pura (sem banco): gerar os candidatos e decidir o vencedor.
// Sem 'server-only' — o worker alcança isso na Fase 2.
// ============================================================

import { isPlausibleBrNational, isPlausibleDDD, normalizePhone, toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

/** Como a cobrança encontrou o contato (guardado para auditoria). */
export type MatchedBy = 'phone' | 'email' | 'code' | 'manual'

/**
 * Formas em que o MESMO telefone brasileiro aparece por aí: o ERP grava sem
 * 55, o WhatsApp grava com, e números antigos não têm o 9º dígito. Geramos
 * todas para procurar, e a decisão de aceitar continua sendo "só se for uma".
 */
export function brPhoneCandidates(raw: string | null | undefined): string[] {
  const d = normalizePhone(raw ?? '')
  if (d.length < 8) return []

  const out = new Set<string>([d])

  // Com e sem o código do país.
  const national = d.startsWith('55') && (d.length === 12 || d.length === 13) ? d.slice(2) : d
  if (national !== d) out.add(national)
  if ((national.length === 10 || national.length === 11) && isPlausibleDDD(national.slice(0, 2))) {
    out.add('55' + national)
  }

  // Com e sem o 9º dígito (celular antigo × novo), só quando o DDD é plausível.
  if (isPlausibleDDD(national.slice(0, 2))) {
    const ddd = national.slice(0, 2)
    const local = national.slice(2)
    if (local.length === 8) {
      const com9 = ddd + '9' + local
      out.add(com9)
      out.add('55' + com9)
    } else if (local.length === 9 && local.startsWith('9')) {
      const sem9 = ddd + local.slice(1)
      out.add(sem9)
      out.add('55' + sem9)
    }
  }

  return [...out].filter((v) => v.length >= 8)
}

/** E-mail comparável: espaços fora, caixa baixa. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase()
}

/** Só os dígitos do CPF/CNPJ (é assim que o cliente digita no código do ERP). */
export function normalizeDocument(raw: string | null | undefined): string {
  const d = (raw ?? '').replace(/\D/g, '')
  return d.length === 11 || d.length === 14 ? d : ''
}

export interface MatchCandidate {
  id: string
  /** De onde esse candidato veio, para carimbar `matched_by`. */
  via: MatchedBy
}

export interface MatchDecision {
  contactId: string | null
  matchedBy: MatchedBy | null
  /** Preenchido quando havia mais de um contato possível — vira pendência. */
  ambiguous: boolean
}

/**
 * Decide o contato a partir dos candidatos encontrados no banco, na ordem de
 * confiança: telefone, depois e-mail, depois código do cliente no ERP.
 *
 * Empate em qualquer um dos níveis → não casa. Melhor uma pendência visível na
 * tela do que uma cobrança na caixa de entrada de outra pessoa.
 */
export function decideMatch(candidates: MatchCandidate[]): MatchDecision {
  for (const via of ['phone', 'email', 'code'] as const) {
    const ids = [...new Set(candidates.filter((c) => c.via === via).map((c) => c.id))]
    if (ids.length === 1) return { contactId: ids[0], matchedBy: via, ambiguous: false }
    if (ids.length > 1) return { contactId: null, matchedBy: null, ambiguous: true }
  }
  return { contactId: null, matchedBy: null, ambiguous: false }
}

/**
 * O vínculo feito por uma PESSOA (asaas_customer_links, migr 0178) vence
 * qualquer palpite: telefone de outro contato, empate de telefone, e-mail.
 * 16/09 (Ótica Exemplo): ligada à mão num contato, a parcela seguinte casou por
 * telefone com OUTRO — cobrada por WhatsApp num e por e-mail no outro.
 * Sem vínculo, é o casamento automático de sempre.
 */
export function decideWithLink(linkedContactId: string | null | undefined, candidates: MatchCandidate[]): MatchDecision {
  if (linkedContactId) return { contactId: linkedContactId, matchedBy: 'manual', ambiguous: false }
  return decideMatch(candidates)
}

/** Dias de atraso a partir do vencimento (negativo = ainda não venceu). */
export function daysOverdue(dueDate: string | null | undefined, today = new Date()): number | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((ref.getTime() - due.getTime()) / 86_400_000)
}

/**
 * Telefone como o Asaas guarda ("67990001631", "(67) 99000-1631", "5567…") →
 * dígitos com DDI, prontos para virar contato do CRM. Só aceita número
 * brasileiro plausível: cadastro com telefone estrangeiro ou quebrado continua
 * pendência (uma pessoa resolve), não vira contato de lixo.
 */
export function asaasPhoneForContact(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  const digits = text.replace(/\D/g, '')
  // "+370…" tem os mesmos 11 dígitos de um número de Minas sem o sinal: o "+"
  // é a única pista de que o número já veio internacional — respeitamos.
  const d = text.startsWith('+') ? digits : toBrE164IfNational(digits)
  if (!/^55\d{10,11}$/.test(d)) return null
  // DDD, e celular com o 9 na frente — "55 55 1298…" não é número de ninguém.
  if (!isPlausibleBrNational(d.slice(2))) return null
  return d
}

// ------------------------------------------ clientes duplicados no Asaas (item 5)

export interface CustomerLite {
  id: string
  name?: string | null
  cpfCnpj?: string | null
  mobilePhone?: string | null
  phone?: string | null
  email?: string | null
}

export interface DuplicateGroup {
  by: 'cpf' | 'phone' | 'email'
  key: string
  customers: { id: string; name: string | null }[]
}

// ------------------------------------------ qual cadastro recebe a cobrança (15/09)
// Caso João/GoLink: o CNPJ tinha DOIS cadastros no Asaas — o verdadeiro (com
// endereço, para a nota fiscal) e um órfão criado pelo CRM. O `limit: 1`
// pegava qualquer um. Agora a escolha é determinística e fica aqui, pura.

export interface PickableCustomer {
  id: string
  cpfCnpj?: string | null
  externalReference?: string | null
  postalCode?: string | null
  addressNumber?: string | null
  deleted?: boolean | null
  /** YYYY-MM-DD (o Asaas manda só a data). */
  dateCreated?: string | null
}

/** CEP e número preenchidos — o mínimo para o Asaas emitir nota fiscal. */
export function hasFullAddress(c: { postalCode?: string | null; addressNumber?: string | null }): boolean {
  return !!(c.postalCode ?? '').replace(/\D/g, '') && !!(c.addressNumber ?? '').trim()
}

/** Id do Asaas (cus_000001234567): mais curto antes, depois ordem de texto. */
function compareAsaasId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** Endereço completo > mais antigo (sem data → menor id) > nosso externalReference > menor id. */
function preferRealCustomer(externalReference: string | null | undefined) {
  return (a: PickableCustomer, b: PickableCustomer): number => {
    const addr = Number(hasFullAddress(b)) - Number(hasFullAddress(a))
    if (addr) return addr
    const da = (a.dateCreated ?? '').trim()
    const dbb = (b.dateCreated ?? '').trim()
    if (da && dbb) {
      if (da !== dbb) return da < dbb ? -1 : 1
    } else {
      const byId = compareAsaasId(a.id, b.id)
      if (byId) return byId
    }
    if (externalReference) {
      const ours = Number(b.externalReference === externalReference) - Number(a.externalReference === externalReference)
      if (ours) return ours
    }
    return compareAsaasId(a.id, b.id)
  }
}

/**
 * Entre os cadastros devolvidos pela busca por CPF/CNPJ, o que recebe a
 * cobrança. Fora os apagados e quem não tem EXATAMENTE esse documento.
 */
export function pickCustomerForDocument<T extends PickableCustomer>(
  list: readonly T[] | null | undefined,
  doc: string,
  externalReference?: string | null,
): T | undefined {
  const d = normalizeDocument(doc)
  if (!d) return undefined
  const ok = (list ?? []).filter((c) => c.deleted !== true && normalizeDocument(c.cpfCnpj) === d)
  return [...ok].sort(preferRealCustomer(externalReference))[0]
}

/**
 * Entre os cadastros com o NOSSO externalReference: o do mesmo documento, senão
 * o órfão sem documento (para adotar). NUNCA um cadastro com OUTRO documento —
 * seria cobrar em nome de outra pessoa. Sem documento informado, prefere quem já
 * tem documento (o Asaas de produção exige) ao órfão.
 */
export function pickCustomerForReference<T extends PickableCustomer>(
  list: readonly T[] | null | undefined,
  externalReference: string,
  doc?: string | null,
): T | undefined {
  const d = normalizeDocument(doc)
  const mine = (list ?? []).filter((c) => c.deleted !== true && !!externalReference && c.externalReference === externalReference)
  const order = preferRealCustomer(externalReference)
  // Órfão = campo de documento VAZIO. Documento estranho (CNPJ com letras, por
  // exemplo) não é órfão: é de alguém, e não se sobrescreve.
  const orphans = () => mine.filter((c) => !(c.cpfCnpj ?? '').trim()).sort(order)
  if (d) {
    const same = mine.filter((c) => normalizeDocument(c.cpfCnpj) === d).sort(order)
    return same[0] ?? orphans()[0]
  }
  const withDoc = mine.filter((c) => !!normalizeDocument(c.cpfCnpj)).sort(order)
  return withDoc[0] ?? orphans()[0]
}

/** DDD + 8 dígitos locais: tolera 55 e 9º dígito. Vazio quando não parece BR. */
function phoneIdentity(raw: string | null | undefined): string {
  let d = (raw ?? '').replace(/\D/g, '')
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2)
  if (d.length === 11 && d[2] === '9') d = d.slice(0, 2) + d.slice(3)
  return d.length === 10 && isPlausibleDDD(d.slice(0, 2)) ? d : ''
}

/**
 * Cadastros que são a MESMA pessoa: primeiro por CPF/CNPJ, depois por telefone
 * (entre quem não caiu num grupo de documento), depois por e-mail. Cada
 * cadastro aparece em no máximo um grupo. Não decide nada — mostra.
 */
export function groupDuplicateCustomers(list: CustomerLite[]): DuplicateGroup[] {
  const out: DuplicateGroup[] = []
  const taken = new Set<string>()
  const pass = (by: DuplicateGroup['by'], keyOf: (c: CustomerLite) => string) => {
    const buckets = new Map<string, CustomerLite[]>()
    for (const c of list) {
      if (taken.has(c.id)) continue
      const k = keyOf(c)
      if (!k) continue
      buckets.set(k, [...(buckets.get(k) ?? []), c])
    }
    for (const [key, cs] of buckets) {
      if (cs.length < 2) continue
      for (const c of cs) taken.add(c.id)
      out.push({ by, key, customers: cs.map((c) => ({ id: c.id, name: c.name ?? null })) })
    }
  }
  pass('cpf', (c) => normalizeDocument(c.cpfCnpj))
  pass('phone', (c) => phoneIdentity(c.mobilePhone) || phoneIdentity(c.phone))
  pass('email', (c) => normalizeEmail(c.email))
  return out
}

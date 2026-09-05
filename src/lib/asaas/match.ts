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

import { isPlausibleDDD, normalizePhone, toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

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

/** Dias de atraso a partir do vencimento (negativo = ainda não venceu). */
export function daysOverdue(dueDate: string | null | undefined, today = new Date()): number | null {
  if (!dueDate) return null
  const due = new Date(`${dueDate.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const ref = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((ref.getTime() - due.getTime()) / 86_400_000)
}

/**
 * Telefone como o Asaas guarda ("67992361631", "(67) 99236-1631", "5567…") →
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
  if (!isPlausibleDDD(d.slice(2, 4))) return null
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

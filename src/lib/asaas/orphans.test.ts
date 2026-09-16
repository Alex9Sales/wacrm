import { describe, expect, it } from 'vitest'

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
  type OrphanFacts,
} from './orphans'

// Caso real (16/09): órfão da FluxiaCRM criado em 08/09 14:48 para o contato
// do Alex, sem CPF; o cadastro verdadeiro é cus_000199053973.
const REF = '09e0fe5d-d60d-41a4-9a22-a7e07c28589a'
const CPF = '52998224725'
const OUTRO_CPF = '11144477735'
const CNPJ = '11222333000181'
const CONN = '13c62959-a509-4a6d-8bba-c7587ed6aad4'

const facts = (over: Partial<OrphanFacts> = {}): OrphanFacts => ({
  contactExists: true,
  payments: 0,
  subscriptions: 0,
  invoices: 0,
  localCharges: 0,
  isBillingCustomer: false,
  knownDoc: null,
  knownDocSource: null,
  docTakenBy: null,
  validElsewhere: [],
  ...over,
})

const zero = { payments: 0, subscriptions: 0, invoices: 0 }

describe('isCrmOrphanCandidate / crmReferenceOf', () => {
  it('documento vazio ou só espaços, ref UUID, não apagado → candidato', () => {
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: '', externalReference: REF })).toBe(true)
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: '   ', externalReference: REF })).toBe(true)
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: null, externalReference: ` ${REF.toUpperCase()} ` })).toBe(true)
  })

  it('documento preenchido (até com letras) não é órfão', () => {
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: CPF, externalReference: REF })).toBe(false)
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: 'AB123', externalReference: REF })).toBe(false)
  })

  it('ref de ERP, vazio ou apagado → não é candidato', () => {
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: '', externalReference: 'ERP-123' })).toBe(false)
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: '', externalReference: '' })).toBe(false)
    expect(isCrmOrphanCandidate({ id: 'cus_1', cpfCnpj: '', externalReference: REF, deleted: true })).toBe(false)
  })

  it('crmReferenceOf devolve o UUID em minúsculas', () => {
    expect(crmReferenceOf({ externalReference: REF.toUpperCase() })).toBe(REF)
    expect(crmReferenceOf({ externalReference: '12345' })).toBeNull()
  })

  it('maskDigits mostra só 3 primeiros e 2 últimos', () => {
    expect(maskDigits(CPF)).toBe('529…25')
    expect(maskDigits('')).toBe('-')
    expect(maskDigits('123')).toBe('…')
  })
})

describe('pickKnownDocument — de onde veio o documento', () => {
  it('confirmado (origin ai/manual ou matched_by manual/code) vence campo e telefone', () => {
    const rows = [
      { cpfCnpj: OUTRO_CPF, origin: 'sync', matchedBy: 'phone' },
      { cpfCnpj: CPF, origin: 'sync', matchedBy: 'code' },
    ]
    expect(pickKnownDocument({ rows, customField: CNPJ })).toEqual({ doc: CPF, source: 'confirmed' })
    expect(confirmedDocumentsOf(rows)).toEqual([CPF])
  })

  it('só linha casada por telefone → phone_match (e o campo personalizado vem antes dela)', () => {
    const rows = [{ cpfCnpj: OUTRO_CPF, origin: 'sync', matchedBy: 'phone' }]
    expect(pickKnownDocument({ rows })).toEqual({ doc: OUTRO_CPF, source: 'phone_match' })
    expect(pickKnownDocument({ rows, customField: CNPJ })).toEqual({ doc: CNPJ, source: 'custom_field' })
  })

  it('digitado válido vence tudo; digitado inválido não cai no conhecido', () => {
    const rows = [{ cpfCnpj: CPF, origin: 'ai', matchedBy: null }]
    expect(pickKnownDocument({ typed: '111.444.777-35', rows })).toEqual({ doc: OUTRO_CPF, source: 'typed' })
    expect(pickKnownDocument({ typed: '12345678900', rows })).toEqual({ doc: null, source: null })
  })

  it('nada conhecido → null', () => {
    expect(pickKnownDocument({})).toEqual({ doc: null, source: null })
  })
})

describe('classifyOrphan', () => {
  it('caso da Fluxia: contato existe, tudo zero, válido noutro cadastro → delete com o válido no motivo', () => {
    const d = classifyOrphan(facts({ validElsewhere: ['FluxiaCRM:cus_000199053973'] }))
    expect(d.verdict).toBe('delete')
    expect(d.reason).toContain('FluxiaCRM:cus_000199053973')
  })

  it('consulta que falhou (null) → review, nunca delete', () => {
    expect(classifyOrphan(facts({ payments: null })).verdict).toBe('review')
    expect(classifyOrphan(facts({ subscriptions: null })).verdict).toBe('review')
    expect(classifyOrphan(facts({ invoices: null })).verdict).toBe('review')
  })

  it('linha na carteira do CRM com zero no Asaas nunca vira delete', () => {
    expect(classifyOrphan(facts({ localCharges: 1 })).verdict).not.toBe('delete')
  })

  it('nota fiscal conta como vínculo', () => {
    expect(classifyOrphan(facts({ invoices: 1 })).verdict).toBe('keep_warn')
  })

  it('contato inexistente → review; cadastro da assinatura Fluxia → skip mesmo com tudo zero', () => {
    expect(classifyOrphan(facts({ contactExists: false })).verdict).toBe('review')
    expect(classifyOrphan(facts({ isBillingCustomer: true })).verdict).toBe('skip')
  })

  it('com cobrança e documento casado por TELEFONE → keep_warn, nunca set_document (15/09 Sérgio × João)', () => {
    const d = classifyOrphan(facts({ payments: 1, knownDoc: CPF, knownDocSource: 'phone_match' }))
    expect(d.verdict).toBe('keep_warn')
    expect(d.reason).not.toContain(CPF)
    expect(classifyOrphan(facts({ payments: 1, knownDoc: CPF, knownDocSource: 'custom_field' })).verdict).toBe('keep_warn')
  })

  it('com cobrança e documento confirmado sem dono → set_document; já de outro cadastro → keep_warn', () => {
    expect(classifyOrphan(facts({ payments: 1, knownDoc: CPF, knownDocSource: 'confirmed' })).verdict).toBe('set_document')
    expect(classifyOrphan(facts({ subscriptions: 2, knownDoc: CPF, knownDocSource: 'typed' })).verdict).toBe('set_document')
    const taken = classifyOrphan(facts({ payments: 1, knownDoc: CPF, knownDocSource: 'confirmed', docTakenBy: 'cus_x' }))
    expect(taken.verdict).toBe('keep_warn')
    expect(taken.reason).toContain('cus_x')
  })

  it('assinatura sem documento conhecido → keep_warn', () => {
    expect(classifyOrphan(facts({ subscriptions: 1 })).verdict).toBe('keep_warn')
  })
})

describe('safeToDelete — reconferência ao vivo', () => {
  const orphan = { id: 'cus_1', cpfCnpj: '', externalReference: REF }

  it('continua órfão, mesmo ref e tudo zero → true', () => {
    expect(safeToDelete(orphan, REF, zero)).toBe(true)
    expect(safeToDelete({ ...orphan, externalReference: REF.toUpperCase() }, REF, zero)).toBe(true)
  })

  it('ganhou documento depois do inventário (adotado) → false', () => {
    expect(safeToDelete({ ...orphan, cpfCnpj: CPF }, REF, zero)).toBe(false)
  })

  it('ref diferente, apagado ou sem GET → false', () => {
    expect(safeToDelete({ ...orphan, externalReference: '7864e77d-0000-4000-8000-000000000000' }, REF, zero)).toBe(false)
    expect(safeToDelete({ ...orphan, deleted: true }, REF, zero)).toBe(false)
    expect(safeToDelete(null, REF, zero)).toBe(false)
  })

  it('qualquer contagem diferente de zero, ou desconhecida, → false', () => {
    expect(safeToDelete(orphan, REF, { ...zero, payments: 1 })).toBe(false)
    expect(safeToDelete(orphan, REF, { ...zero, subscriptions: 1 })).toBe(false)
    expect(safeToDelete(orphan, REF, { ...zero, invoices: 1 })).toBe(false)
    expect(safeToDelete(orphan, REF, { ...zero, payments: null })).toBe(false)
  })
})

describe('decideSetDocument — só documento digitado', () => {
  const fresh = { id: 'cus_1', cpfCnpj: '', externalReference: REF }
  const base = { fresh, expectedRef: REF, typedDoc: CPF, contactExists: true, takenBy: null }

  it('órfão, contato existe, documento válido e livre → ok', () => {
    expect(decideSetDocument(base)).toEqual({ ok: true, doc: CPF })
  })

  it('documento inválido, já de outro cadastro, cadastro mudou ou contato não existe → recusa', () => {
    expect(decideSetDocument({ ...base, typedDoc: '12345678900' }).ok).toBe(false)
    expect(decideSetDocument({ ...base, takenBy: 'cus_2' }).ok).toBe(false)
    expect(decideSetDocument({ ...base, fresh: { ...fresh, cpfCnpj: OUTRO_CPF } }).ok).toBe(false)
    expect(decideSetDocument({ ...base, fresh: { ...fresh, deleted: true } }).ok).toBe(false)
    expect(decideSetDocument({ ...base, fresh: { ...fresh, externalReference: 'ERP-1' } }).ok).toBe(false)
    expect(decideSetDocument({ ...base, contactExists: false }).ok).toBe(false)
  })
})

describe('classes B e C — só relatório', () => {
  const crm = { id: 'cus_crm', cpfCnpj: CNPJ, externalReference: REF }

  it('B: documento do cadastro do CRM está noutro cadastro ativo sem esse ref (caso João/GoLink)', () => {
    const list = [crm, { id: 'cus_real', cpfCnpj: '11.222.333/0001-81', externalReference: null }]
    const r = classifyCrmDuplicate(crm, true, list)
    expect(r?.verdict).toBe('report')
    expect(r?.others).toEqual(['cus_real'])
    expect(r?.reason).not.toContain(CNPJ)
  })

  it('B: outro apagado, outro com o mesmo ref, contato inexistente ou sem documento → nada', () => {
    expect(classifyCrmDuplicate(crm, true, [crm, { id: 'cus_x', cpfCnpj: CNPJ, deleted: true }])).toBeNull()
    expect(classifyCrmDuplicate(crm, true, [crm, { id: 'cus_x', cpfCnpj: CNPJ, externalReference: REF }])).toBeNull()
    expect(classifyCrmDuplicate(crm, false, [crm, { id: 'cus_x', cpfCnpj: CNPJ }])).toBeNull()
    expect(classifyCrmDuplicate({ ...crm, cpfCnpj: '' }, true, [{ id: 'cus_x', cpfCnpj: '' }])).toBeNull()
  })

  it('C: documento diferente de todos os confirmados → report; igual a um deles ou sem confirmado → nada', () => {
    const c = { id: 'cus_crm', cpfCnpj: OUTRO_CPF, externalReference: REF }
    const r = classifySuspiciousDocument(c, true, [CPF])
    expect(r?.verdict).toBe('report')
    expect(r?.reason).not.toContain(OUTRO_CPF)
    expect(classifySuspiciousDocument(c, true, [CPF, OUTRO_CPF])).toBeNull()
    expect(classifySuspiciousDocument(c, true, [])).toBeNull()
    expect(classifySuspiciousDocument(c, false, [CPF])).toBeNull()
    expect(classifySuspiciousDocument({ ...c, externalReference: 'ERP-9' }, true, [CPF])).toBeNull()
  })
})

describe('parseOrphanArgs — erro de digitação nunca vira escrita', () => {
  const ok = (argv: string[]) => {
    const r = parseOrphanArgs(argv)
    if (!r.ok || r.help) throw new Error(`esperava opções: ${JSON.stringify(r)}`)
    return r.options
  }
  const err = (argv: string[]) => {
    const r = parseOrphanArgs(argv)
    if (r.ok) throw new Error(`esperava erro: ${JSON.stringify(r)}`)
    return r.error
  }

  it('sem argumentos → inventário em dry-run de todas as conexões', () => {
    expect(ok([])).toEqual({ connectionId: null, apply: false, action: { kind: 'inventory' } })
    expect(ok(['--connection', CONN]).connectionId).toBe(CONN)
  })

  it('--apply sem ação, ou ação sem --connection → erro', () => {
    expect(err(['--apply'])).toMatch(/--apply exige/)
    expect(err(['--connection', CONN, '--apply'])).toMatch(/--apply exige/)
    expect(err(['--delete', 'cus_1', '--apply'])).toMatch(/--connection/)
    expect(err(['--restore', 'cus_1'])).toMatch(/--connection/)
  })

  it('--delete sem --apply é simulação; ids repetidos somem', () => {
    expect(ok(['--connection', CONN, '--delete', 'cus_a,cus_b,cus_a'])).toEqual({
      connectionId: CONN,
      apply: false,
      action: { kind: 'delete', ids: ['cus_a', 'cus_b'] },
    })
    expect(ok(['--connection', CONN, '--restore', 'cus_a', '--apply']).apply).toBe(true)
  })

  it('flag desconhecida (--aply), id fora do formato, conexão que não é uuid, duas ações → erro', () => {
    expect(err(['--connection', CONN, '--delete', 'cus_a', '--aply'])).toMatch(/desconhecido/)
    expect(err(['--connection', CONN, '--delete', 'cus_a/../payments'])).toMatch(/formato/)
    expect(err(['--connection', 'golink', '--delete', 'cus_a'])).toMatch(/uuid/)
    expect(err(['--connection', CONN, '--delete', 'cus_a', '--restore', 'cus_b'])).toMatch(/uma ação/)
    expect(err(['--connection', CONN, '--delete'])).toMatch(/precisa de um valor/)
  })

  it('--set-document só com --doc válido e um id', () => {
    expect(ok(['--connection', CONN, '--set-document', 'cus_a', '--doc', '529.982.247-25']).action).toEqual({
      kind: 'set_document',
      id: 'cus_a',
      doc: CPF,
    })
    expect(err(['--connection', CONN, '--set-document', 'cus_a'])).toMatch(/--doc/)
    expect(err(['--connection', CONN, '--set-document', 'cus_a', '--doc', '12345678900'])).toMatch(/válido/)
    expect(err(['--connection', CONN, '--set-document', 'cus_a,cus_b', '--doc', CPF])).toMatch(/um id/)
    expect(err(['--connection', CONN, '--delete', 'cus_a', '--doc', CPF])).toMatch(/--doc só vale/)
  })

  it('--help', () => {
    expect(parseOrphanArgs(['--help'])).toEqual({ ok: true, help: true })
  })
})

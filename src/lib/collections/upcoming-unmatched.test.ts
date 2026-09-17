import { describe, expect, it } from 'vitest'

import {
  addDaysKey,
  buildUnmatchedRows,
  canCreateFromAsaas,
  customerRefKey,
  dueInText,
  purgePlan,
  sameDocumentOthers,
  uniqueCustomerRefs,
  unmatchedReasonText,
  visibleUpcoming,
  type UnmatchedEntry,
} from './upcoming-unmatched'

const GOLINK = 'conn-golink'
const ASAAS = 'conn-asaas'

const entry = (over: Partial<UnmatchedEntry> & { payment: UnmatchedEntry['payment'] }): UnmatchedEntry => ({
  connectionId: GOLINK,
  customerId: 'cus_speed',
  customer: { name: 'Speed Gás e Água', mobilePhone: '12996706499', email: 'speed@x.com', cpfCnpj: '12.345.678/0001-90' },
  reason: 'no_contact',
  ...over,
})

describe('buildUnmatchedRows — o retrato de quem vai vencer sem contato', () => {
  it('duas parcelas do mesmo cliente viram um cartão, total em centavos e próximo vencimento = menor data', () => {
    const rows = buildUnmatchedRows([
      entry({ payment: { id: 'pay_1', value: 350, dueDate: '2026-09-20', invoiceUrl: 'https://asaas/i/1' } }),
      entry({ payment: { id: 'pay_2', value: 0.1, dueDate: '2026-09-18', invoiceUrl: null } }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].total).toBe(350.1)
    expect(rows[0].nextDueDate).toBe('2026-09-18')
    expect(rows[0].payments.map((p) => p.id)).toEqual(['pay_2', 'pay_1'])
    expect(rows[0].payments[1].invoiceUrl).toBe('https://asaas/i/1')
    expect(rows[0]).toMatchObject({ name: 'Speed Gás e Água', phone: '12996706499', email: 'speed@x.com', cpfCnpj: '12.345.678/0001-90' })
  })

  it('o mesmo cus_ em conexões diferentes vira 2 cartões (o id é por conta do Asaas)', () => {
    const rows = buildUnmatchedRows([
      entry({ payment: { id: 'pay_1', value: 10, dueDate: '2026-09-18' } }),
      entry({ connectionId: ASAAS, payment: { id: 'pay_9', value: 20, dueDate: '2026-09-19' } }),
    ])
    expect(rows.map((r) => r.connectionId).sort()).toEqual([ASAAS, GOLINK])
  })

  it('uma parcela ambígua deixa o cartão inteiro ambíguo', () => {
    const rows = buildUnmatchedRows([
      entry({ payment: { id: 'pay_1', value: 10, dueDate: '2026-09-18' } }),
      entry({ reason: 'ambiguous', payment: { id: 'pay_2', value: 10, dueDate: '2026-09-19' } }),
    ])
    expect(rows[0].reason).toBe('ambiguous')
  })

  it('corta a data, valor null vira 0, telefone fixo quando não há celular, nome só com espaço vira null', () => {
    const [r] = buildUnmatchedRows([
      entry({
        customer: { name: '   ', mobilePhone: '', phone: '(12) 3648-8533', email: null, cpfCnpj: null },
        payment: { id: 'pay_1', value: null, dueDate: '2026-09-20T00:00:00' },
      }),
    ])
    expect(r.name).toBeNull()
    expect(r.phone).toBe('(12) 3648-8533')
    expect(r.payments[0]).toEqual({ id: 'pay_1', value: 0, dueDate: '2026-09-20', invoiceUrl: null, description: null })
    expect(r.total).toBe(0)
  })

  it('a mesma parcela lida duas vezes não soma duas vezes', () => {
    const [r] = buildUnmatchedRows([
      entry({ payment: { id: 'pay_1', value: 350, dueDate: '2026-09-18' } }),
      entry({ payment: { id: 'pay_1', value: 350, dueDate: '2026-09-18' } }),
    ])
    expect(r.payments).toHaveLength(1)
    expect(r.total).toBe(350)
  })
})

describe('visibleUpcoming — a tela olha as parcelas, não a menor data', () => {
  const [row] = buildUnmatchedRows([
    entry({ payment: { id: 'ontem', value: 100, dueDate: '2026-09-15' } }),
    entry({ payment: { id: 'hoje', value: 50, dueDate: '2026-09-16' } }),
    entry({ payment: { id: 'amanha', value: 25.5, dueDate: '2026-09-17' } }),
    entry({ payment: { id: 'longe', value: 999, dueDate: '2026-09-30' } }),
  ])

  it('esconde a de ontem (venceu) e a de fora da janela; mantém a de hoje e a de amanhã, com total refeito', () => {
    const [v] = visibleUpcoming([row], '2026-09-16', 5)
    expect(v.payments.map((p) => p.id)).toEqual(['hoje', 'amanha'])
    expect(v.total).toBe(75.5)
    expect(v.nextDueDate).toBe('2026-09-16')
  })

  it('o último dia da janela entra', () => {
    const [v] = visibleUpcoming([row], '2026-09-25', 5)
    expect(v.payments.map((p) => p.id)).toEqual(['longe'])
  })

  it('cartão sem nenhuma parcela visível some', () => {
    expect(visibleUpcoming([row], '2026-10-01', 5)).toEqual([])
  })

  it('não mexe no cartão original', () => {
    visibleUpcoming([row], '2026-09-16', 1)
    expect(row.payments).toHaveLength(4)
  })

  it('addDaysKey vira o mês', () => {
    expect(addDaysKey('2026-09-28', 5)).toBe('2026-10-03')
  })
})

describe('purgePlan — cliente que não abriu não é gravado nem apagado', () => {
  it('leitura dos clientes falhou inteira (429): não limpa nada', () => {
    expect(purgePlan({ customersOk: false, unknownCustomerIds: [] }).purge).toBe(false)
  })

  it('cliente que não abriu entra no keep, sem repetição', () => {
    expect(purgePlan({ customersOk: true, unknownCustomerIds: ['cus_B', 'cus_B', ''] })).toEqual({ purge: true, keep: ['cus_B'] })
  })

  it('nada desconhecido: limpa tudo o que não foi visto nesta leitura', () => {
    expect(purgePlan({ customersOk: true, unknownCustomerIds: new Set<string>() })).toEqual({ purge: true, keep: [] })
  })
})

describe('sameDocumentOthers — só dica, nunca vínculo em cascata', () => {
  it('mesmo CNPJ nas duas contas do Asaas: cada cartão sabe que há outro', () => {
    const m = sameDocumentOthers([
      { connectionId: GOLINK, customerId: 'cus_1', cpfCnpj: '12.345.678/0001-90' },
      { connectionId: ASAAS, customerId: 'cus_2', cpfCnpj: '12345678000190' },
      { connectionId: ASAAS, customerId: 'cus_3', cpfCnpj: null },
      { connectionId: ASAAS, customerId: 'cus_4', cpfCnpj: '1234567890' },
    ])
    expect(m.get(customerRefKey({ connectionId: GOLINK, customerId: 'cus_1' }))).toBe(1)
    expect(m.get(customerRefKey({ connectionId: ASAAS, customerId: 'cus_2' }))).toBe(1)
    expect(m.get(customerRefKey({ connectionId: ASAAS, customerId: 'cus_3' }))).toBe(0)
    // Documento com 10 dígitos não é CPF nem CNPJ: não junta ninguém.
    expect(m.get(customerRefKey({ connectionId: ASAAS, customerId: 'cus_4' }))).toBe(0)
  })
})

describe('uniqueCustomerRefs', () => {
  it('ignora cobrança sem cliente do Asaas e repete (conexão, cliente) uma vez só', () => {
    expect(
      uniqueCustomerRefs([
        { connectionId: GOLINK, asaasCustomerId: 'cus_1' },
        { connectionId: GOLINK, asaasCustomerId: 'cus_1' },
        { connectionId: ASAAS, asaasCustomerId: 'cus_1' },
        { connectionId: ASAAS, asaasCustomerId: null },
      ]),
    ).toEqual([
      { connectionId: GOLINK, customerId: 'cus_1' },
      { connectionId: ASAAS, customerId: 'cus_1' },
    ])
  })
})

describe('canCreateFromAsaas', () => {
  it('celular ou fixo brasileiro servem; estrangeiro sem e-mail não; e-mail sozinho serve', () => {
    expect(canCreateFromAsaas('(12) 99670-6499', null)).toBe(true)
    expect(canCreateFromAsaas('(12) 3648-8533', null)).toBe(true)
    expect(canCreateFromAsaas('+370 612 34567', null)).toBe(false)
    expect(canCreateFromAsaas(null, 'Fin@X.com ')).toBe(true)
    expect(canCreateFromAsaas(null, '')).toBe(false)
  })
})

describe('textos da tela', () => {
  it('motivo', () => {
    expect(unmatchedReasonText('no_contact')).toBe('Nenhum contato do CRM com este telefone, e-mail ou CPF/CNPJ')
    expect(unmatchedReasonText('ambiguous')).toBe('Mais de um contato do CRM com este telefone — escolha o certo')
  })

  it('quando vence', () => {
    expect(dueInText('2026-09-16', '2026-09-16')).toBe('vence hoje')
    expect(dueInText('2026-09-17', '2026-09-16')).toBe('vence amanhã')
    expect(dueInText('2026-09-21', '2026-09-16')).toBe('vence em 5 dias')
    expect(dueInText('2026-09-15', '2026-09-16')).toBe('já venceu')
    expect(dueInText(null, '2026-09-16')).toBe('sem vencimento')
  })
})

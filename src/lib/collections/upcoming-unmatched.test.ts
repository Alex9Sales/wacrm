import { describe, expect, it } from 'vitest'

import {
  addDaysKey,
  buildUnmatchedRows,
  canCreateFromAsaas,
  canRemoveCreatedContact,
  chargesChangedByLink,
  CREATE_AMBIGUOUS_ERROR,
  CREATE_CHECK_FAILED_ERROR,
  createProbeKeys,
  createRefusal,
  customerRefKey,
  dueInText,
  holdDeliveryError,
  linkDeliveryInfo,
  linkMayMoveCharge,
  linkOutcomeTexts,
  MAX_CHARGE_RESTORE,
  OPTED_OUT_DELIVERY_ERROR,
  purgePlan,
  recentLinkName,
  recentLinksSince,
  recentUnlinkText,
  relinkCustomerName,
  reminderAfterLinkText,
  restoreTarget,
  sameDocumentOthers,
  sanitizeChargeRestore,
  undoResultText,
  uniqueCustomerRefs,
  unlinkDebtorText,
  unmatchedReasonText,
  visibleUpcoming,
  type ChargeRestore,
  type CreatedContactDeps,
  type LinkDeliveryInfo,
  type UnmatchedEntry,
} from './upcoming-unmatched'

const GOLINK = 'conn-golink'
const ASAAS = 'conn-asaas'

const entry = (over: Partial<UnmatchedEntry> & { payment: UnmatchedEntry['payment'] }): UnmatchedEntry => ({
  connectionId: GOLINK,
  customerId: 'cus_veloz',
  customer: { name: 'Veloz Gás e Água', mobilePhone: '12990001234', email: 'veloz@x.com', cpfCnpj: '12.345.678/0001-90' },
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
    expect(rows[0]).toMatchObject({ name: 'Veloz Gás e Água', phone: '12990001234', email: 'veloz@x.com', cpfCnpj: '12.345.678/0001-90' })
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
        customer: { name: '   ', mobilePhone: '', phone: '(12) 3000-4321', email: null, cpfCnpj: null },
        payment: { id: 'pay_1', value: null, dueDate: '2026-09-20T00:00:00' },
      }),
    ])
    expect(r.name).toBeNull()
    expect(r.phone).toBe('(12) 3000-4321')
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

  it('leva o primeiro nome não vazio do Asaas para o vínculo (lista "Ligados nos últimos dias")', () => {
    expect(
      uniqueCustomerRefs([
        { connectionId: GOLINK, asaasCustomerId: 'cus_1', customerName: '  ' },
        { connectionId: GOLINK, asaasCustomerId: 'cus_1', customerName: 'Veloz Gás e Água' },
        { connectionId: GOLINK, asaasCustomerId: 'cus_1', customerName: 'Outro nome' },
        { connectionId: ASAAS, asaasCustomerId: 'cus_2', customerName: null },
      ]),
    ).toEqual([
      { connectionId: GOLINK, customerId: 'cus_1', customerName: 'Veloz Gás e Água' },
      { connectionId: ASAAS, customerId: 'cus_2' },
    ])
  })
})

describe('createRefusal — "Criar contato" nunca chuta entre dois contatos (revisão 16/09)', () => {
  it('2+ contatos com o telefone, e-mail ou CPF/CNPJ: recusa com a mesma mensagem da carteira e do painel', () => {
    expect(createRefusal({ ambiguous: true })).toBe(CREATE_AMBIGUOUS_ERROR)
    expect(CREATE_AMBIGUOUS_ERROR).toContain('Ligar a um contato')
  })

  it('ninguém, ou um só: pode criar (um só, findOrCreateContact reencontra ele)', () => {
    expect(createRefusal({ ambiguous: false })).toBeNull()
  })

  it('a conferência falhou: recusa em vez de criar às cegas', () => {
    expect(createRefusal(null)).toBe(CREATE_CHECK_FAILED_ERROR)
    expect(CREATE_CHECK_FAILED_ERROR).toContain('Tente de novo')
  })
})

describe('createProbeKeys — confere pela mesma chave que a criação procura (revisão 16/09)', () => {
  it('telefone que serve para criar: só o telefone (e-mail e CPF/CNPJ empatados não recusam)', () => {
    expect(createProbeKeys('(12) 99000-1234', 'financeiro@empresa.com')).toEqual({ phone: '5512990001234', email: null })
  })

  it('telefone que não serve ("+1…", vazio): só o e-mail, normalizado', () => {
    expect(createProbeKeys('+1 415 555 0123', ' Fin@X.com ')).toEqual({ phone: null, email: 'fin@x.com' })
    expect(createProbeKeys(null, 'fin@x.com')).toEqual({ phone: null, email: 'fin@x.com' })
    expect(createProbeKeys('', '  ')).toEqual({ phone: null, email: null })
  })
})

describe('linkDeliveryInfo / linkOutcomeTexts — o aviso depois de ligar só promete o canal conferido', () => {
  const base: LinkDeliveryInfo = { contactName: 'RS Vidros', contactHasPhone: true, phoneDiffers: false, deliveryLabel: 'WhatsApp', deliveryError: null }

  it('monta a partir da ficha: nome cai para o telefone, 10+ dígitos é telefone, diferença pelos 8 últimos', () => {
    expect(
      linkDeliveryInfo({ contactName: ' ', contactPhone: '5512990001234', optedOut: false, asaasPhone: '(12) 99000-1234', delivery: { ok: true, label: 'WhatsApp' } }),
    ).toEqual({ contactName: '5512990001234', contactHasPhone: true, phoneDiffers: false, deliveryLabel: 'WhatsApp', deliveryError: null })
    // Sem o 9º dígito no Asaas: os 8 últimos batem, não é "outro telefone".
    expect(linkDeliveryInfo({ contactName: 'Veloz', contactPhone: '5512990001234', optedOut: false, asaasPhone: '1290001234', delivery: null }).phoneDiffers).toBe(false)
    expect(linkDeliveryInfo({ contactName: 'Veloz', contactPhone: '5512990001234', optedOut: false, asaasPhone: '12 3000-4321', delivery: null }).phoneDiffers).toBe(true)
    // Ficha sem telefone: não é "outro telefone", é "sem telefone".
    expect(linkDeliveryInfo({ contactName: 'RS Vidros', contactPhone: '', optedOut: false, asaasPhone: '1130004321', delivery: null })).toMatchObject({
      contactHasPhone: false,
      phoneDiffers: false,
      deliveryLabel: null,
      deliveryError: null,
    })
  })

  it('resultado da conferência: rótulo quando sai, motivo quando não sai; quem pediu SAIR não recebe', () => {
    const noWay = { ok: false as const, error: 'A régua cobra só por WhatsApp e o contato não tem telefone válido.' }
    expect(linkDeliveryInfo({ contactName: 'X', contactPhone: null, optedOut: false, asaasPhone: null, delivery: noWay })).toMatchObject({
      deliveryLabel: null,
      deliveryError: noWay.error,
    })
    expect(
      linkDeliveryInfo({ contactName: 'X', contactPhone: '5512990001234', optedOut: true, asaasPhone: null, delivery: { ok: true, label: 'WhatsApp' } }),
    ).toMatchObject({ deliveryLabel: null, deliveryError: OPTED_OUT_DELIVERY_ERROR })
  })

  it('lembrete que não sai (R&S Vidros: ficha sem telefone, régua só por WhatsApp): diz que NÃO sai e não promete e-mail', () => {
    const r = { ...base, contactHasPhone: false, deliveryLabel: null, deliveryError: 'A régua cobra só por WhatsApp e o contato não tem telefone válido.' }
    const t = linkOutcomeTexts('R&S Vidros', true, r)
    expect(t.warning).toBe('O lembrete de R&S Vidros NÃO vai sair: A régua cobra só por WhatsApp e o contato não tem telefone válido.')
    expect(t.reminder).toBe('')
    expect(`${t.reminder} ${t.warning}`).not.toMatch(/e-mail|próxima rodada/)
  })

  it('ficha sem telefone com e-mail que a régua usa: sai só por e-mail, e a tela diz', () => {
    const t = linkOutcomeTexts('R&S Vidros', true, { ...base, contactHasPhone: false, deliveryLabel: 'e-mail' })
    expect(t.reminder).toBe('O lembrete sai por e-mail na próxima rodada da régua.')
    expect(t.warning).toBe('A ficha de RS Vidros não tem telefone: o lembrete não sai por WhatsApp, só por e-mail.')
  })

  it('conferência falhou: não promete canal nem que sai', () => {
    const t = linkOutcomeTexts('R&S Vidros', true, { ...base, contactHasPhone: false, deliveryLabel: null })
    expect(t.reminder).toMatch(/^Não deu para conferir/)
    expect(t.warning).toBe('A ficha de RS Vidros não tem telefone: o lembrete não sai por WhatsApp.')
    expect(`${t.reminder} ${t.warning}`).not.toMatch(/só por e-mail/)
  })

  it('tudo certo: diz o canal e não avisa; régua desligada não promete "próxima rodada"', () => {
    expect(linkOutcomeTexts('Veloz Gás', true, base)).toEqual({ reminder: 'O lembrete sai por WhatsApp na próxima rodada da régua.', warning: null })
    expect(linkOutcomeTexts('Veloz Gás', false, base).reminder).toBe(reminderAfterLinkText(false))
  })

  it('telefone diferente do Asaas avisa quando o lembrete vai por WhatsApp; só por e-mail, não importa', () => {
    expect(linkOutcomeTexts('Veloz Gás', true, { ...base, phoneDiffers: true }).warning).toMatch(/tem outro telefone/)
    expect(linkOutcomeTexts('Veloz Gás', true, { ...base, phoneDiffers: true, deliveryLabel: 'WhatsApp e e-mail' }).warning).toMatch(/tem outro telefone/)
    expect(linkOutcomeTexts('Veloz Gás', true, { ...base, phoneDiffers: true, deliveryLabel: 'e-mail' }).warning).toBeNull()
    // Não sai de jeito nenhum: o motivo vence o aviso do telefone.
    expect(linkOutcomeTexts('Veloz Gás', true, { ...base, phoneDiffers: true, deliveryLabel: null, deliveryError: 'Sem como alcançar: x; y.' }).warning).toMatch(
      /NÃO vai sair/,
    )
  })
})

describe('freio da régua no aviso depois de ligar — a mesma ordem da fila (revisão 16/09)', () => {
  const ok = { ok: true as const, label: 'WhatsApp' }
  const info = (hold: Parameters<typeof linkDeliveryInfo>[0]['hold'], over: Partial<Parameters<typeof linkDeliveryInfo>[0]> = {}) =>
    linkDeliveryInfo({ contactName: 'Centro Pisos', contactPhone: '5511999990000', optedOut: false, asaasPhone: null, delivery: ok, hold, ...over })

  it('pausado: NÃO vai sair, com o motivo e o botão de retomar; sem rótulo de canal', () => {
    const r = info({ kind: 'paused', reason: ' pediu acordo ' })
    expect(r).toMatchObject({ deliveryLabel: null, deliveryError: 'A régua está parada neste cliente (pediu acordo) — use "Retomar cobrança" em Cobranças para o lembrete sair.' })
    const t = linkOutcomeTexts('Centro Pisos', true, r)
    expect(t.reminder).toBe('')
    expect(t.warning).toMatch(/^O lembrete de Centro Pisos NÃO vai sair: /)
  })

  it('promessa: diz até quando, no fuso da conta; sem data válida, sem "até"', () => {
    expect(holdDeliveryError({ kind: 'snoozed', reason: 'prometeu pagar', until: '2026-09-20T02:00:00Z' })).toBe(
      'A régua está parada neste cliente até 19/09 (prometeu pagar) — enquanto isso, o lembrete não sai.',
    )
    expect(holdDeliveryError({ kind: 'snoozed', until: '2026-09-20T02:00:00Z' }, 'UTC')).toContain('até 20/09 —')
    // Fuso quebrado cai no de São Paulo em vez de derrubar o aviso.
    expect(holdDeliveryError({ kind: 'snoozed', until: '2026-09-20T02:00:00Z' }, 'Nada/Disso')).toContain('até 19/09')
    expect(holdDeliveryError({ kind: 'snoozed', until: 'lixo' })).toBe('A régua está parada neste cliente — enquanto isso, o lembrete não sai.')
    expect(linkOutcomeTexts('X', true, info({ kind: 'snoozed', until: '2026-09-20T12:00:00Z' })).reminder).toBe('')
  })

  it('limite de toques: NÃO vai sair e diz como zerar', () => {
    const r = info({ kind: 'max_touches' })
    expect(r.deliveryError).toContain('Zerar toques')
    expect(linkOutcomeTexts('X', true, r).warning).toMatch(/NÃO vai sair: Chegou no limite/)
  })

  it('SAIR vence o freio; sem freio, vale a conferência do canal', () => {
    expect(info({ kind: 'paused' }, { optedOut: true }).deliveryError).toBe(OPTED_OUT_DELIVERY_ERROR)
    expect(info(null)).toMatchObject({ deliveryLabel: 'WhatsApp', deliveryError: null })
    expect(info(undefined, { delivery: { ok: false, error: 'sem canal' } })).toMatchObject({ deliveryLabel: null, deliveryError: 'sem canal' })
  })
})

describe('linkMayMoveCharge — o Ligar do painel segue a regra da sincronização (revisão 16/09)', () => {
  it('espelhada do Asaas vai; emitida pelo CRM só quando está sem contato', () => {
    expect(linkMayMoveCharge({ origin: 'sync', contactId: 'c1' })).toBe(true)
    expect(linkMayMoveCharge({ origin: 'sync', contactId: null })).toBe(true)
    expect(linkMayMoveCharge({ origin: 'ai', contactId: 'socio' })).toBe(false)
    expect(linkMayMoveCharge({ origin: 'manual', contactId: 'socio' })).toBe(false)
    expect(linkMayMoveCharge({ origin: 'ai', contactId: null })).toBe(true)
  })
})

describe('"Ligados nos últimos dias" — onde desligar depois que o Desfazer some', () => {
  it('janela: dias do lembrete + 7', () => {
    const now = Date.parse('2026-09-16T12:00:00Z')
    expect(recentLinksSince(now, 3)).toBe('2026-09-06T12:00:00.000Z')
    expect(recentLinksSince(now, 0)).toBe('2026-09-09T12:00:00.000Z')
    expect(recentLinksSince(now, Number.NaN)).toBe('2026-09-09T12:00:00.000Z')
  })

  it('nome: o do Asaas; vínculo sem nome (antes da 0179) mostra o cus_', () => {
    expect(recentLinkName(' Veloz Gás e Água ', 'cus_1')).toBe('Veloz Gás e Água')
    expect(recentLinkName(null, 'cus_000123')).toBe('cliente cus_000123 do Asaas')
    expect(recentLinkName('  ', 'cus_000123')).toBe('cliente cus_000123 do Asaas')
  })

  it('desligar: não promete que o cliente volta (a régua casa sozinha se alguém tiver os dados) e avisa da fila', () => {
    const t = recentUnlinkText({ customerName: 'Veloz Gás e Água', contactName: 'Veloz Matriz', ruleEnabled: true })
    expect(t).toMatch(/^Desligado: Veloz Gás e Água não está mais ligado a Veloz Matriz\./)
    expect(t).toContain('Se nenhum contato tiver o telefone, o e-mail ou o CPF/CNPJ do Asaas')
    expect(t).toContain('na próxima rodada da régua')
    expect(t).toContain('inclusive Veloz Matriz')
    expect(t).toContain('não é cancelado')
    expect(recentUnlinkText({ customerName: 'A', contactName: 'B', ruleEnabled: false })).toContain('quando a régua for religada')
  })

  it('fila: manda recusar o de hoje sem prometer que tira o lembrete do contato certo (revisão 16/09)', () => {
    const t = recentUnlinkText({ customerName: 'Veloz Gás e Água', contactName: 'Veloz Matriz', ruleEnabled: true })
    expect(t).toContain('O lembrete de hoje que ainda estiver na fila para Veloz Matriz não é cancelado: recuse em "Precisa de você"')
    expect(t).toContain('o contato certo ainda recebe o lembrete quando for ligado')
    expect(t).toContain('Pedido de outro dia já expirou sozinho.')
    expect(t).not.toMatch(/confira em "Precisa de você"/)
  })

  it('nome devolvido pelo Desfazer do Desligar: só texto, aparado, com teto', () => {
    expect(relinkCustomerName('  Veloz Gás e Água ')).toBe('Veloz Gás e Água')
    expect(relinkCustomerName('   ')).toBeNull()
    expect(relinkCustomerName(42)).toBeNull()
    expect(relinkCustomerName(null)).toBeNull()
    expect(relinkCustomerName('x'.repeat(500))).toHaveLength(200)
  })
})

describe('canCreateFromAsaas', () => {
  it('celular ou fixo brasileiro servem; estrangeiro sem e-mail não; e-mail sozinho serve', () => {
    expect(canCreateFromAsaas('(12) 99000-1234', null)).toBe(true)
    expect(canCreateFromAsaas('(12) 3000-4321', null)).toBe(true)
    expect(canCreateFromAsaas('+370 612 34567', null)).toBe(false)
    expect(canCreateFromAsaas(null, 'Fin@X.com ')).toBe(true)
    expect(canCreateFromAsaas(null, '')).toBe(false)
  })
})

// ids no formato do banco (uuid) — o desfazer descarta o que não for.
const X = '11111111-1111-4111-8111-111111111111'
const Y = '22222222-2222-4222-8222-222222222222'
const Z = '33333333-3333-4333-8333-333333333333'
const VENCIDA = 'aaaaaaaa-0000-4000-8000-000000000001'
const DA_IA = 'aaaaaaaa-0000-4000-8000-000000000002'
const SOLTA = 'aaaaaaaa-0000-4000-8000-000000000003'
const POR_TELEFONE = 'aaaaaaaa-0000-4000-8000-000000000004'

/**
 * O que o banco faz, em memória: ligar muda só `chargesChangedByLink`; o
 * desfazer devolve cada item com `restoreTarget`, e só se a linha ainda está
 * 'manual' no contato do clique (a condição do UPDATE em unlinkUpcomingCustomer).
 */
function linkThenUndo(
  rows: ChargeRestore[],
  contactId: string,
  existing: ReadonlySet<string>,
  /** Alguém mexe entre o clique e o desfazer. */
  between: (rows: ChargeRestore[]) => ChargeRestore[] = (r) => r,
) {
  const restore = chargesChangedByLink(rows, contactId)
  const changedIds = new Set(restore.map((r) => r.id))
  const afterLink = between(rows.map((r) => (changedIds.has(r.id) ? { ...r, contactId, matchedBy: 'manual' } : { ...r })))
  // Ida e volta pelo navegador (JSON), como no toast.
  const byId = new Map(sanitizeChargeRestore(JSON.parse(JSON.stringify(restore))).map((r) => [r.id, r]))
  const afterUndo = afterLink.map((r) => {
    const item = byId.get(r.id)
    if (!item || r.contactId !== contactId || r.matchedBy !== 'manual') return r
    return { ...r, ...restoreTarget(item, existing) }
  })
  return { restore, afterLink, afterUndo }
}

describe('Desfazer do painel — devolve só o que o clique mudou (16/09)', () => {
  it('vencida ligada à mão a X ANTES da 0178 e cobrança criada pela IA para X: ligar a X não mexe nelas e o desfazer não as zera', () => {
    const rows: ChargeRestore[] = [
      { id: VENCIDA, contactId: X, matchedBy: 'manual' },
      { id: DA_IA, contactId: X, matchedBy: 'manual' },
    ]
    const { restore, afterUndo } = linkThenUndo(rows, X, new Set([X]))
    expect(restore).toEqual([])
    expect(afterUndo).toEqual(rows)
  })

  it('a vencida era de Z (à mão) e o clique foi em Y: o desfazer devolve para Z, não para "Sem contato"', () => {
    const rows: ChargeRestore[] = [
      { id: VENCIDA, contactId: Z, matchedBy: 'manual' },
      { id: SOLTA, contactId: null, matchedBy: null },
      { id: POR_TELEFONE, contactId: X, matchedBy: 'phone' },
    ]
    const { restore, afterLink, afterUndo } = linkThenUndo(rows, Y, new Set([Z, X]))
    expect(restore).toEqual(rows)
    expect(afterLink.every((r) => r.contactId === Y && r.matchedBy === 'manual')).toBe(true)
    expect(afterUndo).toEqual(rows)
  })

  it('uma já "manual" no contato do clique e outra dele só por telefone: só a do telefone entra no desfazer', () => {
    const restore = chargesChangedByLink(
      [
        { id: VENCIDA, contactId: X, matchedBy: 'manual' },
        { id: POR_TELEFONE, contactId: X, matchedBy: 'phone' },
      ],
      X,
    )
    expect(restore).toEqual([{ id: POR_TELEFONE, contactId: X, matchedBy: 'phone' }])
  })

  it('quem mexeu depois do clique não é sobrescrito', () => {
    const rows: ChargeRestore[] = [
      { id: VENCIDA, contactId: Z, matchedBy: 'manual' },
      { id: SOLTA, contactId: null, matchedBy: null },
    ]
    // Entre o clique (em Y) e o desfazer, alguém desligou a vencida na carteira.
    const { afterUndo } = linkThenUndo(rows, Y, new Set([Z, Y]), (r) =>
      r.map((c) => (c.id === VENCIDA ? { ...c, contactId: null, matchedBy: null } : c)),
    )
    expect(afterUndo).toEqual([
      { id: VENCIDA, contactId: null, matchedBy: null },
      { id: SOLTA, contactId: null, matchedBy: null },
    ])
  })

  it('contato de antes apagado no meio: a cobrança volta sem contato (sem "manual" preso a ninguém)', () => {
    expect(restoreTarget({ id: VENCIDA, contactId: Z, matchedBy: 'manual' }, new Set())).toEqual({ contactId: null, matchedBy: null })
    expect(restoreTarget({ id: VENCIDA, contactId: Z, matchedBy: 'manual' }, new Set([Z]))).toEqual({ contactId: Z, matchedBy: 'manual' })
    expect(restoreTarget({ id: SOLTA, contactId: null, matchedBy: null }, new Set())).toEqual({ contactId: null, matchedBy: null })
  })
})

describe('sanitizeChargeRestore — a lista volta do navegador', () => {
  it('descarta id que não é uuid, contato inválido vira nulo, matched_by desconhecido vira nulo, sem repetir', () => {
    expect(
      sanitizeChargeRestore([
        { id: VENCIDA, contactId: Z, matchedBy: 'manual' },
        { id: VENCIDA, contactId: X, matchedBy: 'phone' },
        { id: 'pay_123', contactId: Z, matchedBy: 'manual' },
        { id: SOLTA, contactId: "x' OR 1=1", matchedBy: 'hack' },
        null,
        'lixo',
      ]),
    ).toEqual([
      { id: VENCIDA, contactId: X, matchedBy: 'phone' },
      { id: SOLTA, contactId: null, matchedBy: null },
    ])
  })

  it('não-lista vira lista vazia e há teto', () => {
    expect(sanitizeChargeRestore(undefined)).toEqual([])
    expect(sanitizeChargeRestore({ id: VENCIDA })).toEqual([])
    const muitos = Array.from({ length: MAX_CHARGE_RESTORE + 50 }, (_, i) => ({
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      contactId: null,
      matchedBy: null,
    }))
    expect(sanitizeChargeRestore(muitos)).toHaveLength(MAX_CHARGE_RESTORE)
  })
})

describe('canRemoveCreatedContact — "Criar contato" desfeito apaga o contato que acabou de nascer', () => {
  const livre: CreatedContactDeps = {
    recent: true,
    createdByUser: true,
    conversations: false,
    deals: false,
    links: false,
    charges: false,
    actionRequests: false,
    notes: false,
    tags: false,
    schedule: false,
    history: false,
  }

  it('recém-criado por quem desfaz e sem nada preso: apaga (senão o telefone do Asaas casava sozinho com ele — Veloz Gás)', () => {
    expect(canRemoveCreatedContact(livre)).toBe(true)
  })

  it('qualquer dependência (o apagar é em cascata), criado há mais tempo ou por outra pessoa, mantém', () => {
    for (const k of ['conversations', 'deals', 'links', 'charges', 'actionRequests', 'notes', 'tags', 'schedule', 'history'] as const) {
      expect(canRemoveCreatedContact({ ...livre, [k]: true })).toBe(false)
    }
    expect(canRemoveCreatedContact({ ...livre, recent: false })).toBe(false)
    expect(canRemoveCreatedContact({ ...livre, createdByUser: false })).toBe(false)
    expect(canRemoveCreatedContact(null)).toBe(false)
  })

  it('só um false claro conta como "sem uso" (o banco pode devolver null)', () => {
    expect(canRemoveCreatedContact({ ...livre, tags: null as unknown as boolean })).toBe(false)
    expect(canRemoveCreatedContact({ ...livre, createdByUser: null as unknown as boolean })).toBe(false)
  })
})

describe('textos do Ligar/Criar/Desfazer — sem prometer o que não acontece', () => {
  it('ligar: com a régua desligada o lembrete não sai "na próxima rodada"', () => {
    expect(reminderAfterLinkText(true)).toBe('O lembrete sai na próxima rodada da régua.')
    expect(reminderAfterLinkText(false)).toBe('A régua está desligada: o lembrete só sai quando ela for religada.')
  })

  it('desfazer o ligar', () => {
    expect(undoResultText({ kind: 'linked', contactRemoved: false, contactName: 'RS Vidros', ruleEnabled: true })).toBe(
      'Desfeito: o cliente volta para a lista na próxima rodada da régua.',
    )
    expect(undoResultText({ kind: 'linked', contactRemoved: false, contactName: 'RS Vidros', ruleEnabled: false })).toBe(
      'Desfeito: o cliente volta para a lista quando a régua for religada.',
    )
  })

  it('desfazer o criar: apagado diz que apagou; mantido avisa que vai casar de novo', () => {
    expect(undoResultText({ kind: 'created', contactRemoved: true, contactName: 'Veloz Gás e Água', ruleEnabled: true })).toBe(
      'Desfeito: o contato criado foi apagado e o cliente volta para a lista na próxima rodada da régua.',
    )
    const mantido = undoResultText({ kind: 'created', contactRemoved: false, contactName: 'Veloz Gás e Água', ruleEnabled: true })
    expect(mantido).toContain('"Veloz Gás e Água" continua no CRM')
    expect(mantido).toContain('vai casar com ele de novo')
    expect(mantido).not.toContain('volta para a lista')
  })

  it('desfazer quando o contato já existia: nunca diz que o cliente volta para a lista', () => {
    const t = undoResultText({ kind: 'existing', contactRemoved: false, contactName: 'Veloz Gás Matriz', ruleEnabled: true })
    expect(t).toContain('"Veloz Gás Matriz" já existia')
    expect(t).toContain('vai continuar casando com ele')
    expect(t).not.toContain('volta para a lista')
  })

  it('desligar contato na carteira: casamento automático volta na sincronização, e a tela diz', () => {
    expect(unlinkDebtorText('manual')).toBe(
      'Contato desligado — voltou para as pendências. A próxima sincronização só liga de novo se o telefone, o e-mail ou o CPF/CNPJ do Asaas for o desta ficha.',
    )
    for (const via of ['phone', 'email', 'code', null]) {
      const t = unlinkDebtorText(via)
      expect(t).toContain('a próxima sincronização liga de novo')
      expect(t).not.toContain('deixam de ir para ele')
    }
  })
})

describe('textos da tela', () => {
  it('motivo', () => {
    expect(unmatchedReasonText('no_contact')).toBe('Nenhum contato do CRM com este telefone, e-mail ou CPF/CNPJ')
    // Empate por e-mail ou CPF/CNPJ também é "ambiguous" (decideMatch).
    expect(unmatchedReasonText('ambiguous')).toBe('Mais de um contato do CRM com o mesmo telefone, e-mail ou CPF/CNPJ — escolha o certo')
  })

  it('quando vence', () => {
    expect(dueInText('2026-09-16', '2026-09-16')).toBe('vence hoje')
    expect(dueInText('2026-09-17', '2026-09-16')).toBe('vence amanhã')
    expect(dueInText('2026-09-21', '2026-09-16')).toBe('vence em 5 dias')
    expect(dueInText('2026-09-15', '2026-09-16')).toBe('já venceu')
    expect(dueInText(null, '2026-09-16')).toBe('sem vencimento')
  })
})

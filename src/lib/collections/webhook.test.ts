import { describe, expect, it, vi, beforeEach } from 'vitest'

// O banco é falsificado: aqui interessa a DECISÃO do webhook (fechar? cancelar
// o que está na fila? reabrir?), não o SQL.
const pauseMock = vi.hoisted(() => ({ settle: vi.fn(async () => 'none' as const) }))
vi.mock('./pause', () => ({ settlePauseAfterPayment: pauseMock.settle }))

const state = {
  charge: null as null | { id: string; contactId: string | null; open: boolean; status?: string },
  aindaDeve: false,
  owners: [] as { contactId: string }[],
  /** Donos vindos do vínculo MANUAL da carteira (asaas_customer_links). */
  manualOwners: [] as { contactId: string }[],
  updates: [] as { table: string; set: Record<string, unknown> }[],
  cancelled: [] as { id: string }[],
}

vi.mock('@/db', () => {
  const chain = (table: string) => ({
    set(set: Record<string, unknown>) {
      state.updates.push({ table, set })
      return {
        where: () => ({
          returning: async () => (table === 'agentActionRequests' ? state.cancelled : []),
          then: (r: (v: unknown) => unknown) => Promise.resolve([]).then(r),
        }),
      }
    },
  })
  let selectCall = 0
  return {
    db: {
      update: (t: { _: { name?: string } } | string) => chain(String((t as { tableName?: string }).tableName ?? t)),
      // dono do cadastro do Asaas (pagamento fora da carteira)
      selectDistinct: () => ({
        from: (t: unknown) => {
          const nome = String((t as { tableName?: string })?.tableName ?? '')
          const linhas = nome === 'asaasCustomerLinks' ? state.manualOwners : state.owners
          return { where: () => ({ limit: async () => linhas }) }
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCall += 1
              // 1ª busca = a cobrança do evento; 2ª = "ainda deve algo?"
              if (selectCall === 1) return state.charge ? [state.charge] : []
              return state.aindaDeve ? [{ id: 'outra' }] : []
            },
          }),
        }),
      }),
      __reset: () => {
        selectCall = 0
      },
    },
    agentActionRequests: { tableName: 'agentActionRequests', status: {}, accountId: {}, contactId: {}, actionType: {}, id: {} },
    asaasCharges: { tableName: 'asaasCharges', id: {}, accountId: {}, contactId: {}, asaasId: {}, open: {} },
    asaasConnections: { tableName: 'asaasConnections', id: {}, webhookEvents: {}, webhookToken: {}, accountId: {}, label: {}, enabled: {}, environment: {}, apiKeyEnc: {} },
    collectionsTouches: { tableName: 'collectionsTouches', accountId: {}, contactId: {} },
    asaasCustomerLinks: { tableName: 'asaasCustomerLinks', accountId: {}, connectionId: {}, asaasCustomerId: {}, contactId: {} },
  }
})

vi.mock('@/db/helpers', () => ({
  firstOrNull: <T,>(rows: T[]) => rows[0] ?? null,
}))

const { applyAsaasEvent } = await import('./webhook')

beforeEach(async () => {
  state.charge = { id: 'ch1', contactId: 'c1', open: true }
  state.aindaDeve = false
  state.owners = []
  state.manualOwners = []
  state.updates = []
  state.cancelled = []
  pauseMock.settle.mockClear()
  const dbmod = (await import('@/db')) as unknown as { db: { __reset: () => void } }
  dbmod.db.__reset()
})

const ev = (event: string, id = 'pay_1') => ({ event, payment: { id } })

describe('webhook do Asaas — parar de cobrar quem pagou', () => {
  it('pagamento recebido fecha a cobrança e cancela o que ainda não saiu', async () => {
    state.cancelled = [{ id: 'req1' }]
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(out.action).toBe('settled')
    expect(out.cancelledRequests).toBe(1)
    expect(state.updates.some((u) => u.table === 'asaasCharges' && u.set.open === false)).toBe(true)
  })

  it('quem pagou 1 de 3 parcelas CONTINUA sendo cobrado pelas outras duas', async () => {
    state.aindaDeve = true
    state.cancelled = [{ id: 'req1' }]
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_CONFIRMED'))
    expect(out.action).toBe('settled')
    // A cobrança paga fecha, mas nada é cancelado na fila: ele ainda deve.
    expect(out.cancelledRequests).toBe(0)
    expect(state.updates.some((u) => u.table === 'agentActionRequests')).toBe(false)
  })

  it('estorno reabre a cobrança em vez de deixar como paga', async () => {
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_REFUNDED'))
    expect(out.action).toBe('reopened')
    expect(state.updates.some((u) => u.table === 'asaasCharges' && u.set.open === true)).toBe(true)
  })

  it('cobrança apagada no Asaas sai da carteira', async () => {
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_DELETED'))
    expect(out.action).toBe('gone')
    expect(state.updates.some((u) => u.table === 'asaasCharges' && u.set.open === false)).toBe(true)
  })

  it('evento que não muda nada é ignorado sem tocar em cobrança nenhuma', async () => {
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_UPDATED'))
    expect(out.action).toBe('ignored')
    expect(state.updates.some((u) => u.table === 'asaasCharges')).toBe(false)
  })

  it('pagamento de cobrança que nunca espelhamos não quebra nada', async () => {
    state.charge = null
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(out.action).toBe('unknown_charge')
    expect(out.cancelledRequests).toBe(0)
  })

  it('parcela de acordo paga EM DIA (nunca espelhada) confere a pausa do dono do cadastro, sem nota quando fica', async () => {
    state.charge = null
    state.owners = [{ contactId: 'c9' }]
    const dbmod = (await import('@/db')) as unknown as { db: { __reset: () => void } }
    dbmod.db.__reset()
    const out = await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_p3', customer: 'cus_9' } })
    expect(out.action).toBe('unknown_charge')
    expect(pauseMock.settle).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc1', contactId: 'c9', noteWhenKept: false }))
  })

  it('dono ligado À MÃO na carteira também vale (sem cobrança espelhada, 23/09)', async () => {
    state.charge = null
    state.owners = []
    state.manualOwners = [{ contactId: 'c7' }]
    const dbmod = (await import('@/db')) as unknown as { db: { __reset: () => void } }
    dbmod.db.__reset()
    const out = await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_p4', customer: 'cus_7' } })
    expect(out.action).toBe('unknown_charge')
    expect(pauseMock.settle).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c7' }))
  })

  it('cobrança e vínculo manual apontando para contatos DIFERENTES: ninguém é despausado', async () => {
    state.charge = null
    state.owners = [{ contactId: 'c1' }]
    state.manualOwners = [{ contactId: 'c2' }]
    const dbmod = (await import('@/db')) as unknown as { db: { __reset: () => void } }
    dbmod.db.__reset()
    await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_p5', customer: 'cus_x' } })
    expect(pauseMock.settle).not.toHaveBeenCalled()
  })

  it('cadastro do Asaas de dois contatos, ou sem cadastro no evento: não mexe na pausa', async () => {
    state.charge = null
    state.owners = [{ contactId: 'c1' }, { contactId: 'c2' }]
    await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_x', customer: 'cus_9' } })
    state.owners = [{ contactId: 'c1' }]
    await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_y' } })
    expect(pauseMock.settle).not.toHaveBeenCalled()
  })

  it('evento sem pagamento (teste da URL no Asaas) não faz nada', async () => {
    const out = await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED' })
    expect(out.action).toBe('ignored')
  })

  it('conta o evento mesmo quando ignora — é assim que a tela sabe que a URL foi colada', async () => {
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_UPDATED'))
    expect(state.updates.some((u) => u.table === 'asaasConnections' && 'webhookLastAt' in u.set)).toBe(true)
  })

  it('16/09 Reboque: quitou tudo → confere a pausa da régua no 1º pagamento', async () => {
    state.charge = { id: 'ch1', contactId: 'c1', open: true, status: 'OVERDUE' }
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(pauseMock.settle).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc1', contactId: 'c1', firstSettle: true, stillOwes: false }))
  })

  it('reenvio do Asaas: a pausa é decidida ANTES de gravar a cobrança como paga', async () => {
    // Se o webhook cair depois de gravar "pago" e antes de mexer na pausa, o
    // reenvio acharia status pago → "não é 1º pagamento" → pausa presa.
    state.charge = { id: 'ch1', contactId: 'c1', open: true, status: 'OVERDUE' }
    let chargeClosedBeforeSettle: boolean | null = null
    pauseMock.settle.mockImplementationOnce(async () => {
      chargeClosedBeforeSettle = state.updates.some((u) => u.table === 'asaasCharges' && u.set.open === false)
      return 'none' as const
    })
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(chargeClosedBeforeSettle).toBe(false)
    expect(state.updates.some((u) => u.table === 'asaasCharges' && u.set.open === false)).toBe(true)
  })

  it('manda conferir parcela a vencer no Asaas (a carteira só tem as vencidas)', async () => {
    state.charge = { id: 'ch1', contactId: 'c1', open: true, status: 'OVERDUE' }
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(pauseMock.settle).toHaveBeenCalledWith(expect.objectContaining({ countOpenInAsaas: expect.any(Function) }))
  })

  it('2º aviso de pagamento da mesma cobrança (cartão CONFIRMED → RECEIVED) não é 1º pagamento', async () => {
    state.charge = { id: 'ch1', contactId: 'c1', open: false, status: 'CONFIRMED' }
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(pauseMock.settle).toHaveBeenCalledWith(expect.objectContaining({ firstSettle: false }))
  })

  it('ainda deve outra parcela, cobrança apagada ou estorno: a pausa não é tocada', async () => {
    state.aindaDeve = true
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    state.aindaDeve = false
    const dbmod = (await import('@/db')) as unknown as { db: { __reset: () => void } }
    dbmod.db.__reset()
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_DELETED'))
    dbmod.db.__reset()
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_REFUNDED'))
    expect(pauseMock.settle).not.toHaveBeenCalled()
  })

  it('cobrança paga sem contato casado fecha, mas não tenta cancelar fila', async () => {
    state.charge = { id: 'ch1', contactId: null, open: true }
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(out.action).toBe('settled')
    expect(out.cancelledRequests).toBe(0)
  })
})

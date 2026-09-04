import { describe, expect, it, vi, beforeEach } from 'vitest'

// O banco é falsificado: aqui interessa a DECISÃO do webhook (fechar? cancelar
// o que está na fila? reabrir?), não o SQL.
const state = {
  charge: null as null | { id: string; contactId: string | null; open: boolean },
  aindaDeve: false,
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
      select: () => ({
        from: (t: unknown) => ({
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
    asaasConnections: { tableName: 'asaasConnections', id: {}, webhookEvents: {}, webhookToken: {}, accountId: {}, label: {} },
    collectionsTouches: { tableName: 'collectionsTouches', accountId: {}, contactId: {} },
  }
})

vi.mock('@/db/helpers', () => ({
  firstOrNull: <T,>(rows: T[]) => rows[0] ?? null,
}))

const { applyAsaasEvent } = await import('./webhook')

beforeEach(async () => {
  state.charge = { id: 'ch1', contactId: 'c1', open: true }
  state.aindaDeve = false
  state.updates = []
  state.cancelled = []
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

  it('evento sem pagamento (teste da URL no Asaas) não faz nada', async () => {
    const out = await applyAsaasEvent('conn1', 'acc1', { event: 'PAYMENT_RECEIVED' })
    expect(out.action).toBe('ignored')
  })

  it('conta o evento mesmo quando ignora — é assim que a tela sabe que a URL foi colada', async () => {
    await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_UPDATED'))
    expect(state.updates.some((u) => u.table === 'asaasConnections' && 'webhookLastAt' in u.set)).toBe(true)
  })

  it('cobrança paga sem contato casado fecha, mas não tenta cancelar fila', async () => {
    state.charge = { id: 'ch1', contactId: null, open: true }
    const out = await applyAsaasEvent('conn1', 'acc1', ev('PAYMENT_RECEIVED'))
    expect(out.action).toBe('settled')
    expect(out.cancelledRequests).toBe(0)
  })
})

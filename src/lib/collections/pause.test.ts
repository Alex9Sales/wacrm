import { describe, expect, it, vi, beforeEach } from 'vitest'

// Banco falsificado: interessa a DECISÃO de tirar ou manter a pausa depois
// que o cliente paga, e se o Asaas é consultado quando precisa.
const state = {
  touch: null as null | { paused: boolean; pausedSource: string | null; pausedReason: string | null },
  updates: 0,
  notes: [] as string[],
}

vi.mock('@/db', () => {
  const rows = (v: unknown[]) => ({ limit: async () => v, then: (r: (x: unknown) => unknown) => Promise.resolve(v).then(r) })
  return {
    db: {
      select: (fields: Record<string, unknown>) => ({
        from: () => ({
          where: () => {
            // a conversa mais recente (nota) pede id; o resto é o estado da pausa
            if ('id' in fields) return { orderBy: () => rows([{ id: 'conv1' }]) }
            return rows(state.touch ? [state.touch] : [])
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              state.updates += 1
              return state.touch?.paused ? [{ contactId: 'c1' }] : []
            },
          }),
        }),
      }),
      insert: () => ({
        values: async (v: { contentText: string }) => {
          state.notes.push(v.contentText)
        },
      }),
    },
    collectionsTouches: { accountId: {}, contactId: {}, paused: {}, pausedSource: {}, pausedReason: {}, pausedAt: {} },
    conversations: { id: {}, accountId: {}, contactId: {}, lastMessageAt: {}, createdAt: {} },
    messages: {},
  }
})

vi.mock('@/db/helpers', () => ({
  firstOrNull: <T,>(r: T[]) => r[0] ?? null,
}))

const { settlePauseAfterPayment } = await import('./pause')

const IA = { paused: true, pausedSource: 'ai', pausedReason: 'Cliente pediu acordo/parcelamento' }
const run = (countOpenInAsaas: () => Promise<number | null>, firstSettle = true) =>
  settlePauseAfterPayment({ accountId: 'acc1', contactId: 'c1', firstSettle, stillOwes: false, nowIso: '2026-09-16T12:00:00Z', countOpenInAsaas })

beforeEach(() => {
  state.touch = { ...IA }
  state.updates = 0
  state.notes = []
})

describe('settlePauseAfterPayment — parcela a vencer', () => {
  it('pausa da IA, nada mais em aberto no Asaas → sai, com nota', async () => {
    expect(await run(async () => 0)).toBe('lift')
    expect(state.updates).toBe(1)
    expect(state.notes[0]).toContain('foi retirada')
  })

  it('pagou a vencida mas tem parcela A VENCER no Asaas → pausa fica, nota explica', async () => {
    expect(await run(async () => 2)).toBe('keep_owes')
    expect(state.updates).toBe(0)
    expect(state.notes[0]).toContain('parcela em aberto no Asaas')
  })

  it('Asaas não respondeu → pausa fica, sem nota (continua na lista de régua parada)', async () => {
    expect(await run(async () => null)).toBe('none')
    expect(state.updates).toBe(0)
    expect(state.notes).toHaveLength(0)
  })

  it('parcela fora da carteira (noteWhenKept false): tira a pausa, mas não repete nota quando ela fica', async () => {
    const quiet = (count: () => Promise<number | null>) =>
      settlePauseAfterPayment({ accountId: 'acc1', contactId: 'c1', firstSettle: true, stillOwes: false, nowIso: 'x', countOpenInAsaas: count, noteWhenKept: false })
    expect(await quiet(async () => 1)).toBe('keep_owes')
    state.touch = { paused: true, pausedSource: 'human', pausedReason: 'não cobrar' }
    expect(await quiet(async () => 0)).toBe('keep_human')
    expect(state.notes).toHaveLength(0)
    state.touch = { ...IA }
    expect(await quiet(async () => 0)).toBe('lift')
    expect(state.notes).toHaveLength(1)
  })

  it('pausa da equipe não consulta o Asaas', async () => {
    state.touch = { paused: true, pausedSource: 'human', pausedReason: 'não cobrar' }
    const count = vi.fn(async () => 0)
    expect(await run(count)).toBe('keep_human')
    expect(count).not.toHaveBeenCalled()
  })

  it('2º aviso da mesma cobrança não consulta o Asaas nem mexe na pausa', async () => {
    const count = vi.fn(async () => 0)
    expect(await run(count, false)).toBe('none')
    expect(count).not.toHaveBeenCalled()
    expect(state.updates).toBe(0)
  })

  it('consulta que lança não derruba o webhook', async () => {
    expect(await run(async () => { throw new Error('boom') })).toBe('none')
    expect(state.updates).toBe(0)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 15/09: o rastro só no console sumia a cada deploy. Agora grava em
// broadcast_events — sem nunca lançar (a ação já aconteceu). Banco trocado
// por stub.
const h = vi.hoisted(() => ({
  inserted: [] as { table: unknown; values: Record<string, unknown> }[],
  fail: false,
  savepoints: 0,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const insert = (table: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      if (h.fail) throw new Error('connection refused')
      h.inserted.push({ table, values })
    },
  })
  return { ...actual, db: { insert } }
})

import { broadcastEvents } from '@/db'
import { logBroadcastEvent, type BroadcastAuditTx } from './audit'

const base = {
  broadcastId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  userId: '33333333-3333-4333-8333-333333333333',
}

beforeEach(() => {
  h.inserted = []
  h.fail = false
  h.savepoints = 0
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('logBroadcastEvent', () => {
  it('grava a linha em broadcast_events com o status anterior (e mantém o console)', async () => {
    await logBroadcastEvent({
      ...base,
      action: 'pause',
      role: 'agent',
      previousStatus: 'sending',
      channelId: '44444444-4444-4444-8444-444444444444',
      sentCount: 12,
      extra: { keyId: 'k1' },
    })
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0].table).toBe(broadcastEvents)
    expect(h.inserted[0].values).toEqual({
      accountId: base.accountId,
      broadcastId: base.broadcastId,
      userId: base.userId,
      role: 'agent',
      action: 'pause',
      previousStatus: 'sending',
      channelId: '44444444-4444-4444-8444-444444444444',
      sentCount: 12,
      extra: { keyId: 'k1' },
    })
    expect(console.info).toHaveBeenCalledWith('[broadcast-audit]', expect.stringContaining('"action":"pause"'))
  })

  it('campos opcionais ausentes viram null', async () => {
    await logBroadcastEvent({ ...base, userId: null, action: 'cancel' })
    expect(h.inserted[0].values).toMatchObject({
      userId: null,
      role: null,
      previousStatus: null,
      channelId: null,
      sentCount: null,
      extra: null,
    })
  })

  it('banco fora do ar: não lança, registra o erro no log', async () => {
    h.fail = true
    await expect(logBroadcastEvent({ ...base, action: 'delete' })).resolves.toBeUndefined()
    expect(h.inserted).toHaveLength(0)
    expect(console.error).toHaveBeenCalledWith(
      '[broadcast-audit] não gravou o evento:',
      'delete',
      base.broadcastId,
      'connection refused',
    )
  })

  it('dentro de uma transação usa SAVEPOINT (falha no INSERT não derruba a transação de quem chama)', async () => {
    const tx = {
      transaction: async (fn: (sp: unknown) => Promise<void>) => {
        h.savepoints++
        return fn({
          insert: () => ({
            values: async () => {
              throw new Error('insert failed')
            },
          }),
        })
      },
    } as unknown as BroadcastAuditTx
    await expect(logBroadcastEvent({ ...base, action: 'delete' }, { tx })).resolves.toBeUndefined()
    expect(h.savepoints).toBe(1)
    // Não caiu no db global: o evento é da transação ou de ninguém.
    expect(h.inserted).toHaveLength(0)
  })
})

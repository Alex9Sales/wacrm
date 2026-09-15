import { beforeEach, describe, expect, it, vi } from 'vitest'

// 15/09 (GoLink): pra tirar 2 pessoas da fila a única saída era cancelar e
// refazer o disparo inteiro. Fila (BullMQ) e banco trocados por stubs.
const h = vi.hoisted(() => ({
  broadcast: null as { status: string; channelId: string | null } | null,
  recipient: null as { status: string } | null,
  /** Estado do job na fila do canal (null = não há job). */
  jobState: null as string | null,
  /** removeRecipientJobs consegue tirar o job? (job travado/ativo não sai) */
  jobRemovable: true,
  /** Estado que o job assume DURANTE a remoção (virou ativo no meio). */
  jobStateAfterRemove: undefined as string | null | undefined,
  deletedRows: [{ id: 'r1' }] as { id: string }[],
  queueChannelIds: [] as string[],
  removeCalls: [] as unknown[][],
  deletes: 0,
  updates: [] as Record<string, unknown>[],
  finalizeCalls: [] as string[],
  defaultChannel: { id: 'ch-default' } as { id: string } | null,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const tx = {
    delete: () => ({
      where: () => ({
        returning: async () => {
          h.deletes++
          return h.deletedRows
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          h.updates.push(values)
        },
      }),
    }),
  }
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === actual.broadcasts) return h.broadcast ? [h.broadcast] : []
            if (table === actual.broadcastRecipients) return h.recipient ? [h.recipient] : []
            return []
          },
        }),
      }),
    }),
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  }
  return { ...actual, db }
})

vi.mock('@/lib/queue/queues', () => ({
  outboundQueue: (channelId: string) => {
    h.queueChannelIds.push(channelId)
    return {
      getJob: async () => (h.jobState ? { getState: async () => h.jobState } : undefined),
    }
  },
  removeRecipientJobs: vi.fn(async (...args: unknown[]) => {
    h.removeCalls.push(args)
    if (h.jobStateAfterRemove !== undefined) h.jobState = h.jobStateAfterRemove
    else if (h.jobRemovable) h.jobState = null
  }),
}))

vi.mock('@/lib/queue/broadcast-jobs', () => ({
  finalizeBroadcastIfDone: vi.fn(async (id: string) => {
    h.finalizeCalls.push(id)
  }),
}))

vi.mock('@/lib/channels/channels', () => ({
  loadDefaultChannel: vi.fn(async () => h.defaultChannel),
}))

import { removePendingRecipient } from './recipient-remove'

beforeEach(() => {
  h.broadcast = { status: 'paused', channelId: 'ch-atendimento' }
  h.recipient = { status: 'pending' }
  h.jobState = 'delayed'
  h.jobRemovable = true
  h.jobStateAfterRemove = undefined
  h.deletedRows = [{ id: 'r1' }]
  h.queueChannelIds = []
  h.removeCalls = []
  h.deletes = 0
  h.updates = []
  h.finalizeCalls = []
  h.defaultChannel = { id: 'ch-default' }
})

describe('removePendingRecipient', () => {
  it('tira o job da fila, apaga a linha pendente, ajusta o total e finaliza', async () => {
    const res = await removePendingRecipient('acc', 'b1', 'r1')
    expect(res).toEqual({ ok: true })
    expect(h.removeCalls).toEqual([['ch-atendimento', ['r1']]])
    expect(h.deletes).toBe(1)
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toHaveProperty('totalRecipients')
    expect(h.finalizeCalls).toEqual(['b1'])
  })

  it('aceita disparo agendado e em andamento', async () => {
    for (const status of ['scheduled', 'sending']) {
      h.broadcast = { status, channelId: 'ch-atendimento' }
      h.jobState = null
      expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({ ok: true })
    }
  })

  it('recusa disparo de outra conta / inexistente', async () => {
    h.broadcast = null
    const res = await removePendingRecipient('acc', 'b1', 'r1')
    expect(res.ok).toBe(false)
    expect(h.deletes).toBe(0)
  })

  it('recusa disparo que já terminou, foi cancelado ou é rascunho', async () => {
    for (const status of ['sent', 'failed', 'cancelled', 'draft']) {
      h.broadcast = { status, channelId: 'ch-atendimento' }
      const res = await removePendingRecipient('acc', 'b1', 'r1')
      expect(res.ok).toBe(false)
    }
    expect(h.removeCalls).toHaveLength(0)
    expect(h.deletes).toBe(0)
  })

  it('recusa destinatário que não está pendente', async () => {
    h.recipient = { status: 'sent' }
    expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({
      ok: false,
      error: 'Este destinatário já foi enviado.',
    })
    h.recipient = { status: 'failed' }
    const failed = await removePendingRecipient('acc', 'b1', 'r1')
    expect(failed.ok).toBe(false)
    h.recipient = null
    expect((await removePendingRecipient('acc', 'b1', 'r1')).ok).toBe(false)
    expect(h.deletes).toBe(0)
  })

  it('job ativo (saindo agora) → recusa sem mexer na fila nem no banco', async () => {
    h.jobState = 'active'
    expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({
      ok: false,
      error: 'Este envio já está saindo agora.',
    })
    expect(h.removeCalls).toHaveLength(0)
    expect(h.deletes).toBe(0)
  })

  it('job virou ativo durante a remoção → recusa e não apaga a linha', async () => {
    h.jobState = 'delayed'
    h.jobStateAfterRemove = 'active'
    expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({
      ok: false,
      error: 'Este envio já está saindo agora.',
    })
    expect(h.deletes).toBe(0)
  })

  it('a linha já saiu de pending entre a leitura e o delete → erro, sem ajustar total', async () => {
    h.deletedRows = []
    expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({
      ok: false,
      error: 'Este destinatário já foi enviado.',
    })
    expect(h.updates).toHaveLength(0)
    expect(h.finalizeCalls).toHaveLength(0)
  })

  it('disparo antigo sem canal gravado → usa a fila do canal padrão (como o worker)', async () => {
    h.broadcast = { status: 'sending', channelId: null }
    expect(await removePendingRecipient('acc', 'b1', 'r1')).toEqual({ ok: true })
    expect(h.removeCalls).toEqual([['ch-default', ['r1']]])
  })
})

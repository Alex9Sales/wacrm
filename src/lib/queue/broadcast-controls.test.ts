import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// Revisão 15/09 (GoLink):
//  - excluir apagava de vez um disparo cujo 1º envio estava SAINDO (job ativo,
//    destinatário ainda 'pending' com attempts = 0): o cliente recebia e o
//    histórico sumia → agora arquiva;
//  - o rastro vai pra broadcast_events com o status anterior, e a exclusão
//    real grava o evento ANTES do DELETE, na mesma transação.
// Banco, fila e auditoria trocados por stubs; a regra (deletion-rule) é real.

type Recipient = { id: string; status: string; attempts: number }

const h = vi.hoisted(() => ({
  broadcast: null as null | {
    userId: string
    status: string
    channelId: string | null
    archivedAt: string | null
    sentCount: number
  },
  recipients: [] as { id: string; status: string; attempts: number }[],
  /** Job ativo na fila do canal (broadcastId do job). */
  activeJobs: [] as { data: { broadcastId: string; recipientRowId: string } }[],
  getActiveThrows: false,
  /** Muda o status logo depois da 1ª leitura (corrida com o worker). */
  statusAfterFirstRead: null as string | null,
  reads: 0,
  /** O DELETE condicional não encontra a linha (algo mudou no meio). */
  deleteMatchesNothing: false,
  /** Ordem do que foi efetivado (eventos e DELETE), só o que "commitou". */
  log: [] as string[],
  events: [] as Record<string, unknown>[],
  removedJobs: [] as string[][],
}))

const BID = '11111111-1111-4111-8111-111111111111'
const ACC = '22222222-2222-4222-8222-222222222222'

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const dialect = new PgDialect()
  const params = (cond: SQL) => dialect.sqlToQuery(cond).params

  const select = (fields: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: () => {
        const run = async (): Promise<unknown[]> => {
          if (table === actual.broadcasts) {
            if (!h.broadcast) return []
            if ('userId' in fields) {
              const row = { ...h.broadcast }
              h.reads++
              if (h.reads === 1 && h.statusAfterFirstRead) h.broadcast.status = h.statusAfterFirstRead
              return [row]
            }
            if ('status' in fields) return [{ status: h.broadcast.status }]
            if ('sentCount' in fields) return [{ sentCount: h.broadcast.sentCount }]
          }
          if (table === actual.broadcastRecipients) {
            if ('nonPending' in fields) {
              return [
                {
                  nonPending: h.recipients.filter((r: Recipient) => r.status !== 'pending').length,
                  attempted: h.recipients.filter((r: Recipient) => r.attempts > 0).length,
                },
              ]
            }
            return h.recipients.filter((r: Recipient) => r.status === 'pending').map((r: Recipient) => ({ id: r.id }))
          }
          return []
        }
        const p = run()
        return { limit: () => p, then: p.then.bind(p) }
      },
    }),
  })

  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: (cond: SQL) => ({
        returning: async () => {
          const b = h.broadcast
          if (!b) return []
          if ('archivedAt' in values) {
            if (b.archivedAt) return []
            b.archivedAt = String(values.archivedAt)
            h.log.push('archive')
            return [{ id: BID }]
          }
          // Transição condicional: parâmetros = [id, conta, ...status aceitos].
          const allowed = params(cond).slice(2)
          if (!allowed.includes(b.status)) return []
          b.status = String(values.status)
          return [{ id: BID }]
        },
      }),
    }),
  })

  const makeTx = (buffer: string[]) => ({
    delete: () => ({
      where: () => ({
        returning: async () => {
          if (h.deleteMatchesNothing) return []
          buffer.push('delete')
          return [{ id: BID }]
        },
      }),
    }),
    __buffer: buffer,
  })

  const db = {
    select,
    update,
    // Commit só se a função terminar sem erro (rollback descarta o buffer).
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      const buffer: string[] = []
      const out = await fn(makeTx(buffer))
      h.log.push(...buffer)
      if (buffer.includes('delete')) h.broadcast = null
      return out
    },
  }
  return { ...actual, db }
})

vi.mock('@/lib/broadcasts/audit', () => ({
  logBroadcastEvent: async (event: Record<string, unknown>, opts: { tx?: { __buffer: string[] } } = {}) => {
    const entry = `event:${String(event.action)}`
    if (opts.tx) opts.tx.__buffer.push(entry)
    else h.log.push(entry)
    h.events.push(event)
  },
}))

vi.mock('@/lib/queue/queues', () => ({
  outboundQueue: () => ({
    getActive: async () => {
      if (h.getActiveThrows) throw new Error('redis down')
      return h.activeJobs
    },
  }),
  removeBroadcastDispatchJob: async () => {},
  removeRecipientJobs: async (_channelId: string, ids: string[]) => {
    h.removedJobs.push(ids)
  },
  enqueueBroadcastDispatch: async () => {},
  rescheduleRecipient: async () => {},
}))

vi.mock('@/lib/queue/broadcast-jobs', () => ({ finalizeBroadcastIfDone: async () => {} }))
vi.mock('@/lib/channels/channels', () => ({ loadDefaultChannel: async () => ({ id: 'ch-default' }) }))
vi.mock('@/lib/events/publish', () => ({ publishEvent: async () => {} }))

import { deleteOrArchiveBroadcast, pauseBroadcast, cancelBroadcast } from './broadcast-controls'

const creator = { userId: 'creator-1', role: 'agent' as const }

function setBroadcast(status: string, over: Partial<NonNullable<typeof h.broadcast>> = {}) {
  h.broadcast = { userId: 'creator-1', status, channelId: 'ch-1', archivedAt: null, sentCount: 0, ...over }
}

beforeEach(() => {
  h.broadcast = null
  h.recipients = []
  h.activeJobs = []
  h.getActiveThrows = false
  h.statusAfterFirstRead = null
  h.reads = 0
  h.deleteMatchesNothing = false
  h.log = []
  h.events = []
  h.removedJobs = []
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('deleteOrArchiveBroadcast', () => {
  it('disparo enviando com o 1º envio saindo (job ativo, tudo pendente): ARQUIVA, não apaga (o bug)', async () => {
    setBroadcast('sending')
    h.recipients = [
      { id: 'r1', status: 'pending', attempts: 0 },
      { id: 'r2', status: 'pending', attempts: 0 },
    ]
    h.activeJobs = [{ data: { broadcastId: BID, recipientRowId: 'r1' } }]

    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)

    expect(res).toMatchObject({ ok: true, archived: true, previousStatus: 'sending', cancelled: true })
    expect(h.broadcast?.status).toBe('cancelled')
    expect(h.log).toEqual(['archive', 'event:archive'])
    expect(h.events[0]).toMatchObject({ action: 'archive', previousStatus: 'sending', role: 'agent', userId: 'creator-1' })
  })

  it('esteve enviando, mesmo sem job ativo nem tentativa: arquiva', async () => {
    setBroadcast('sending')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true, previousStatus: 'sending' })
    expect(h.log).not.toContain('delete')
  })

  it('pausado: arquiva', async () => {
    setBroadcast('paused')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true, previousStatus: 'paused', cancelled: true })
  })

  it('agendado que nunca tentou: apaga — e o evento é gravado ANTES do DELETE, na transação', async () => {
    setBroadcast('scheduled')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: false, previousStatus: 'scheduled', cancelled: true })
    expect(h.log).toEqual(['event:delete', 'delete'])
    expect(h.events[0]).toMatchObject({ action: 'delete', previousStatus: 'scheduled', sentCount: 0 })
    expect(h.removedJobs).toEqual([['r1']])
  })

  it('agendado que virou "enviando" no meio: conta como enviando e arquiva', async () => {
    setBroadcast('scheduled')
    h.statusAfterFirstRead = 'sending'
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true, previousStatus: 'sending', cancelled: true })
  })

  it('cancelado sem tentativa e sem job ativo: apaga', async () => {
    setBroadcast('cancelled')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: false, previousStatus: 'cancelled', cancelled: false })
  })

  it('cancelado com job ativo: arquiva', async () => {
    setBroadcast('cancelled')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 0 }]
    h.activeJobs = [{ data: { broadcastId: BID, recipientRowId: 'r1' } }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true })
    expect(h.events[0]).toMatchObject({ action: 'archive', extra: expect.objectContaining({ activeJob: true }) })
  })

  it('job ativo de OUTRO disparo na mesma fila não impede apagar', async () => {
    setBroadcast('cancelled')
    h.activeJobs = [{ data: { broadcastId: 'outro', recipientRowId: 'x' } }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: false })
  })

  it('cancelado com alguém já tentado (attempts > 0): arquiva', async () => {
    setBroadcast('cancelled')
    h.recipients = [{ id: 'r1', status: 'pending', attempts: 1 }]
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true })
  })

  it('não deu pra consultar a fila: na dúvida, arquiva', async () => {
    setBroadcast('cancelled')
    h.getActiveThrows = true
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true })
  })

  it('DELETE não encontrou a linha: o evento de exclusão é desfeito e vira arquivar', async () => {
    setBroadcast('draft')
    h.deleteMatchesNothing = true
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true, previousStatus: 'draft', cancelled: false })
    expect(h.log).toEqual(['archive', 'event:archive'])
  })

  it('pela API: rastro com role api_key, quem criou a chave e o id da chave', async () => {
    setBroadcast('draft')
    await deleteOrArchiveBroadcast(BID, ACC, {
      userId: null,
      role: 'supervisor',
      audit: { userId: 'key-owner', role: 'api_key', extra: { keyId: 'k1' } },
    })
    expect(h.events[0]).toMatchObject({
      action: 'delete',
      userId: 'key-owner',
      role: 'api_key',
      extra: { keyId: 'k1', cancelled: false },
    })
  })

  it('já arquivado: nada muda e nada é gravado', async () => {
    setBroadcast('sent', { archivedAt: '2026-09-15T10:00:00Z', sentCount: 4 })
    const res = await deleteOrArchiveBroadcast(BID, ACC, creator)
    expect(res).toMatchObject({ ok: true, archived: true, alreadyArchived: true })
    expect(h.log).toEqual([])
  })

  it('quem não criou e é agente: recusa sem mexer', async () => {
    setBroadcast('sending')
    const res = await deleteOrArchiveBroadcast(BID, ACC, { userId: 'outro', role: 'agent' })
    expect(res).toMatchObject({ ok: false, code: 'forbidden' })
    expect(h.broadcast?.status).toBe('sending')
  })
})

describe('status anterior nas transições (auditoria)', () => {
  it('pausar diz de onde saiu', async () => {
    setBroadcast('scheduled')
    expect(await pauseBroadcast(BID, ACC, 'u1')).toMatchObject({ ok: true, status: 'paused', previousStatus: 'scheduled' })
  })

  it('pausar algo já pausado continua recusado', async () => {
    setBroadcast('paused')
    expect(await pauseBroadcast(BID, ACC, 'u1')).toMatchObject({ ok: false, code: 'invalid_state' })
  })

  it('cancelar diz de onde saiu; encerrado continua recusado', async () => {
    setBroadcast('paused')
    expect(await cancelBroadcast(BID, ACC)).toMatchObject({ ok: true, status: 'cancelled', previousStatus: 'paused' })
    setBroadcast('sent')
    expect(await cancelBroadcast(BID, ACC)).toMatchObject({ ok: false, code: 'invalid_state' })
  })

  it('cancelar um disparo que não existe: not_found', async () => {
    expect(await cancelBroadcast(BID, ACC)).toMatchObject({ ok: false, code: 'not_found' })
  })
})

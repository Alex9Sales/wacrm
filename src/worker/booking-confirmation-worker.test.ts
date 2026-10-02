import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10 — o worker da confirmação ao agendar: só agenda o tick de 30 s e
// chama a fila (lib/agenda/confirmacao-fila.ts, testada à parte). BullMQ e o
// Redis são falsos aqui; a fila é um espião.

const h = vi.hoisted(() => {
  const state = {
    added: [] as { name: string; opts: Record<string, unknown> }[],
    removed: [] as string[],
    processor: null as null | (() => Promise<unknown>),
    workerOpts: null as null | Record<string, unknown>,
  }
  class Queue {
    async getRepeatableJobs() {
      return [{ key: 'tick-antigo' }]
    }
    async removeRepeatableByKey(key: string) {
      state.removed.push(key)
    }
    async add(name: string, _data: unknown, opts: Record<string, unknown>) {
      state.added.push({ name, opts })
    }
  }
  class Worker {
    constructor(_q: string, processor: () => Promise<unknown>, opts: Record<string, unknown>) {
      state.processor = processor
      state.workerOpts = opts
    }
    on() {
      return this
    }
  }
  return {
    state,
    Queue,
    Worker,
    processar: vi.fn(async () => ({ lidas: 0, enviadas: 0, naoEnviadas: 0, erros: 0 })),
  }
})

vi.mock('bullmq', () => ({ Queue: h.Queue, Worker: h.Worker }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))
vi.mock('@/lib/agenda/confirmacao-fila', () => ({ processarConfirmacoesVencidas: h.processar }))

import { startBookingConfirmationWorker, tickDaConfirmacao } from './booking-confirmation-worker'

beforeEach(() => {
  h.state.added = []
  h.state.removed = []
  h.state.processor = null
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('worker da confirmação ao agendar', () => {
  it('agenda o tick a cada 30 s (troca o agendamento antigo) e avisa no log que subiu', async () => {
    startBookingConfirmationWorker()
    await vi.waitFor(() => expect(h.state.added).toHaveLength(1))

    expect(h.state.removed).toEqual(['tick-antigo'])
    expect(h.state.added[0]).toEqual({
      name: 'booking-confirmation-tick',
      opts: { repeat: { every: 30_000 }, removeOnComplete: true, removeOnFail: 20 },
    })
    // Um tick por vez: a cópia da mesma consulta em outra agenda só é julgada depois da primeira.
    expect(h.state.workerOpts).toMatchObject({ concurrency: 1 })
    expect(console.log).toHaveBeenCalledWith('[booking-confirmation] started — tick every 30s')
  })

  it('cada tick resolve as vencidas pela fila', async () => {
    startBookingConfirmationWorker()

    await h.state.processor?.()

    expect(h.processar).toHaveBeenCalledTimes(1)
  })

  it('só fala no log quando algo não saiu', async () => {
    await tickDaConfirmacao()
    expect(console.warn).not.toHaveBeenCalled()

    h.processar.mockImplementationOnce(async () => ({ lidas: 3, enviadas: 1, naoEnviadas: 1, erros: 1 }))
    await tickDaConfirmacao()
    expect(console.warn).toHaveBeenCalledWith(
      '[booking-confirmation] tick: 3 vencida(s), 1 enviada(s), 1 não enviada(s), 1 com erro',
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10/2026 — o worker do aviso de transferência parada: só agenda o tick de
// 2 min e chama a varredura (lib/alerts/aviso-transferencia-parada.ts,
// testada à parte). BullMQ e o Redis são falsos aqui; a varredura é um espião.

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
    varrer: vi.fn(async () => ({ contas: 0, avisos: 0, erros: 0 })),
  }
})

vi.mock('bullmq', () => ({ Queue: h.Queue, Worker: h.Worker }))
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))
vi.mock('@/lib/alerts/aviso-transferencia-parada', () => ({ varrerTransferenciasParadas: h.varrer }))

import { startHandoffStalledWorker, tickDaTransferenciaParada } from './handoff-stalled-worker'

beforeEach(() => {
  h.state.added = []
  h.state.removed = []
  h.state.processor = null
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('worker da transferência parada', () => {
  it('agenda o tick a cada 2 min (troca o agendamento antigo), um tick por vez', async () => {
    startHandoffStalledWorker()
    await vi.waitFor(() => expect(h.state.added).toHaveLength(1))

    expect(h.state.removed).toEqual(['tick-antigo'])
    expect(h.state.added[0]).toEqual({
      name: 'handoff-stalled-tick',
      opts: { repeat: { every: 120_000 }, removeOnComplete: true, removeOnFail: 20 },
    })
    // Dois ticks juntos leriam a mesma transferência antes da nota-trava.
    expect(h.state.workerOpts).toMatchObject({ concurrency: 1 })
    expect(console.log).toHaveBeenCalledWith('[handoff-stalled] started — tick every 120s')
  })

  it('cada tick roda a varredura', async () => {
    startHandoffStalledWorker()
    await h.state.processor?.()
    expect(h.varrer).toHaveBeenCalledTimes(1)
  })

  it('só fala no log quando avisou ou falhou', async () => {
    await tickDaTransferenciaParada()
    expect(console.log).not.toHaveBeenCalled()

    h.varrer.mockImplementationOnce(async () => ({ contas: 3, avisos: 2, erros: 1 }))
    await tickDaTransferenciaParada()
    expect(console.log).toHaveBeenCalledWith('[handoff-stalled] tick: 3 conta(s), 2 aviso(s), 1 com erro')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Revisão 17/09 (aviso de cobrança nova, GoLink): quem cala o Asaas guarda
// QUANDO e quais cobranças do cliente já existiam — é o que separa "o Asaas
// avisou" de "ninguém avisou" sem depender do `since` que anda todo dia.

const fake = vi.hoisted(() => ({
  store: new Map<string, { value: string; px: number | null }>(),
  down: false,
  listed: [] as { since: string; opts: unknown }[],
  payments: [] as { id?: string; customer?: string }[],
  listFails: false,
  executed: 0,
  executeFails: false,
}))

vi.mock('ioredis', () => {
  class Redis {
    on() {
      return this
    }
    pipeline() {
      const ops: (() => void)[] = []
      const p = {
        set: (key: string, value: string, mode: string, px: number) => {
          ops.push(() => fake.store.set(key, { value, px: mode === 'PX' ? px : null }))
          return p
        },
        exec: async () => {
          if (fake.down) throw new Error('Redis fora')
          ops.forEach((op) => op())
          return []
        },
      }
      return p
    }
    async mget(...keys: string[]) {
      if (fake.down) throw new Error('Redis fora')
      return keys.map((k) => fake.store.get(k)?.value ?? null)
    }
  }
  return { Redis }
})
vi.mock('@/lib/queue/connection', () => ({ bullConnection: () => ({}) }))
vi.mock('@/db', () => ({
  db: {
    execute: vi.fn(async () => {
      fake.executed += 1
      if (fake.executeFails) throw new Error('banco fora')
      return []
    }),
  },
}))
vi.mock('@/lib/asaas/collections', () => ({
  listPaymentsCreatedSince: vi.fn(async (_cred: unknown, since: string, opts: unknown) => {
    fake.listed.push({ since, opts })
    if (fake.listFails) throw new Error('O Asaas não respondeu')
    return fake.payments
  }),
}))

import {
  SILENCED_TTL_MS,
  __resetSilencedForTests,
  listChargesAtSilencing,
  loadSilenced,
  markAsaasNotificationsSwept,
  parseSilencedRecord,
  recordSilenced,
  silencedKey,
} from './asaas-silenced'

const CRED = { apiKey: 'k', environment: 'production' as const }

beforeEach(() => {
  fake.store.clear()
  fake.down = false
  fake.listed = []
  fake.payments = []
  fake.listFails = false
  fake.executed = 0
  fake.executeFails = false
  __resetSilencedForTests()
})

describe('listChargesAtSilencing — o que já existia quando o CRM calou', () => {
  it('desde ontem (UTC), agrupado por cliente, ignorando linha sem id ou cliente', async () => {
    fake.payments = [{ id: 'p1', customer: 'cus_a' }, { id: 'p2', customer: 'cus_a' }, { id: 'p3', customer: 'cus_b' }, { id: 'p4' }, { customer: 'cus_c' }]
    const r = await listChargesAtSilencing(CRED, { now: new Date('2026-09-17T01:30:00Z') })
    // 22h30 de 16/09 em Brasília: "desde ontem" em UTC cobre o dia local inteiro.
    expect(r?.since).toBe('2026-09-16')
    expect(Object.fromEntries(r!.byCustomer)).toEqual({ cus_a: ['p1', 'p2'], cus_b: ['p3'] })
    expect(fake.listed).toEqual([{ since: '2026-09-16', opts: { customer: undefined, timeoutMs: undefined } }])
  })

  it('só de um cliente, com prazo curto (caminho da emissão)', async () => {
    await listChargesAtSilencing(CRED, { customer: 'cus_a', timeoutMs: 8_000, now: new Date('2026-09-17T15:00:00Z') })
    expect(fake.listed).toEqual([{ since: '2026-09-16', opts: { customer: 'cus_a', timeoutMs: 8_000 } }])
  })

  it('o Asaas não respondeu → null (o aviso cai na regra do dia), sem lançar', async () => {
    fake.listFails = true
    await expect(listChargesAtSilencing(CRED)).resolves.toBeNull()
  })
})

describe('recordSilenced / loadSilenced — o rastro no Redis', () => {
  it('grava por conexão e cliente, com validade de 35 dias, e lê de volta num MGET', async () => {
    const lista = { since: '2026-09-15', byCustomer: new Map([['cus_alpha', ['pay_alpha1']]]) }
    await recordSilenced('c-asaas', ['cus_alpha', 'cus_leva', 'cus_alpha', ''], lista, new Date('2026-09-16T12:05:00Z'))
    expect([...fake.store.keys()].sort()).toEqual([silencedKey('c-asaas', 'cus_alpha'), silencedKey('c-asaas', 'cus_leva')])
    expect(fake.store.get(silencedKey('c-asaas', 'cus_alpha'))?.px).toBe(SILENCED_TTL_MS)

    const r = await loadSilenced([
      { connectionId: 'c-asaas', customerId: 'cus_alpha' },
      { connectionId: 'c-asaas', customerId: 'cus_leva' },
      { connectionId: 'c-golink', customerId: 'cus_alpha' },
      { connectionId: 'c-asaas', customerId: 'cus_alpha' },
    ])
    expect(r?.get('c-asaas|cus_alpha')).toEqual({ at: '2026-09-16T12:05:00.000Z', beforeSince: '2026-09-15', before: ['pay_alpha1'] })
    // Calado junto, sem cobrança na lista: lista vazia (não "sem lista").
    expect(r?.get('c-asaas|cus_leva')).toEqual({ at: '2026-09-16T12:05:00.000Z', beforeSince: '2026-09-15', before: [] })
    // Outra conexão: sem registro.
    expect(r?.get('c-golink|cus_alpha')).toBeNull()
  })

  it('sem a lista (listagem falhou) grava só o instante', async () => {
    await recordSilenced('c-asaas', ['cus_x'], null, new Date('2026-09-16T12:05:00Z'))
    const r = await loadSilenced([{ connectionId: 'c-asaas', customerId: 'cus_x' }])
    expect(r?.get('c-asaas|cus_x')).toEqual({ at: '2026-09-16T12:05:00.000Z', beforeSince: null, before: null })
  })

  it('Redis fora: gravar não lança; ler devolve null ("não sei")', async () => {
    fake.down = true
    await expect(recordSilenced('c-asaas', ['cus_x'], null)).resolves.toBeUndefined()
    await expect(loadSilenced([{ connectionId: 'c-asaas', customerId: 'cus_x' }])).resolves.toBeNull()
  })

  it('ninguém para ler ou gravar → nada no Redis', async () => {
    await recordSilenced('c-asaas', [], null)
    expect(fake.store.size).toBe(0)
    expect((await loadSilenced([]))?.size).toBe(0)
  })

  it('registro estragado vira "sem registro"', () => {
    expect(parseSilencedRecord('{')).toBeNull()
    expect(parseSilencedRecord(JSON.stringify({ at: 'ontem' }))).toBeNull()
    expect(parseSilencedRecord(JSON.stringify({ before: ['p'] }))).toBeNull()
    expect(parseSilencedRecord(JSON.stringify({ at: '2026-09-16T12:00:00Z', before: ['p', 3] }))).toEqual({
      at: '2026-09-16T12:00:00Z',
      beforeSince: null,
      before: ['p'],
    })
  })
})

describe('markAsaasNotificationsSwept', () => {
  it('um UPDATE atômico; banco fora não derruba a varredura', async () => {
    await markAsaasNotificationsSwept('acc-1', '2026-09-21T12:00:00Z')
    expect(fake.executed).toBe(1)
    fake.executeFails = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(markAsaasNotificationsSwept('acc-1', '2026-09-21T12:00:00Z')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

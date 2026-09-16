import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { countOpenPaymentsForCustomer, type AsaasCredential } from './collections'

// Pausa da régua só sai quando o Asaas diz que ele não deve mais nada — a
// carteira do CRM só espelha as vencidas (16/09). Mensalidade de assinatura a
// vencer não conta: a próxima existe sempre.

const CRED: AsaasCredential = { apiKey: 'k', environment: 'production' }
const json = (v: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => v, text: async () => JSON.stringify(v) }) as unknown as Response

let byStatus: Record<string, () => Response>

beforeEach(() => {
  vi.stubEnv('ASAAS_BASE_URL', '')
  byStatus = {
    OVERDUE: () => json({ data: [], hasMore: false, totalCount: 0 }),
    PENDING: () => json({ data: [], hasMore: false, totalCount: 0 }),
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('customer')).toBe('cus_1')
      return byStatus[url.searchParams.get('status') ?? '']()
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('countOpenPaymentsForCustomer', () => {
  it('nada em aberto → 0', async () => {
    expect(await countOpenPaymentsForCustomer(CRED, 'cus_1')).toBe(0)
  })

  it('parcela a vencer de acordo → conta', async () => {
    byStatus.PENDING = () => json({ data: [{ id: 'p2', installmentNumber: 2 }, { id: 'p3', installmentNumber: 3 }], hasMore: false, totalCount: 2 })
    expect(await countOpenPaymentsForCustomer(CRED, 'cus_1')).toBe(2)
  })

  it('próxima mensalidade da assinatura a vencer → não conta', async () => {
    byStatus.PENDING = () => json({ data: [{ id: 'm10', subscription: 'sub_1' }], hasMore: false, totalCount: 1 })
    expect(await countOpenPaymentsForCustomer(CRED, 'cus_1')).toBe(0)
  })

  it('mensalidade VENCIDA conta, mesmo sendo de assinatura', async () => {
    byStatus.OVERDUE = () => json({ data: [{ id: 'm9', subscription: 'sub_1' }], hasMore: false, totalCount: 1 })
    expect(await countOpenPaymentsForCustomer(CRED, 'cus_1')).toBe(1)
  })

  it('Asaas com erro ou fora do ar → null (nunca zero)', async () => {
    byStatus.PENDING = () => json({ errors: [{ description: 'x' }] }, 500)
    expect(await countOpenPaymentsForCustomer(CRED, 'cus_1')).toBeNull()
  })
})

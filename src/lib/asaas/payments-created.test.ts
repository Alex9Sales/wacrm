import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AsaasApiError, getCustomerPaymentCreatedFlags, listPaymentsCreatedSince, type AsaasCredential } from './collections'

// 17/09 (GoLink): o aviso de cobrança nova passa a perguntar ao Asaas o que foi
// CRIADO (dateCreated[ge]) e se o próprio Asaas avisa o cliente. Só GET.

const CRED: AsaasCredential = { apiKey: 'k', environment: 'production' }
const json = (v: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => v, text: async () => JSON.stringify(v) }) as unknown as Response

let handler: (url: URL, init?: RequestInit) => Response
const calls: { url: URL; method: string }[] = []

beforeEach(() => {
  vi.stubEnv('ASAAS_BASE_URL', '')
  calls.length = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({ url, method: init?.method ?? 'GET' })
      return handler(url, init)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('listPaymentsCreatedSince', () => {
  it('pede dateCreated[ge] sem filtro de status e pagina até acabar', async () => {
    handler = (url) => {
      const offset = Number(url.searchParams.get('offset'))
      return offset === 0
        ? json({ data: Array.from({ length: 100 }, (_, i) => ({ id: `p${i}` })), hasMore: true })
        : json({ data: [{ id: 'p100' }], hasMore: false })
    }
    const out = await listPaymentsCreatedSince(CRED, '2026-09-15T10:00:00Z')
    expect(out).toHaveLength(101)
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.method).toBe('GET')
      expect(c.url.pathname).toBe('/v3/payments')
      expect(c.url.searchParams.get('dateCreated[ge]')).toBe('2026-09-15')
      expect(c.url.searchParams.get('status')).toBeNull()
      expect(c.url.searchParams.get('customer')).toBeNull()
    }
  })

  // Revisão 17/09: o complemento de cadastro na emissão lista só as do cliente que calou.
  it('com customer: filtra pelo cliente (só GET)', async () => {
    handler = () => json({ data: [{ id: 'p1', customer: 'cus_9' }], hasMore: false })
    const out = await listPaymentsCreatedSince(CRED, '2026-09-16', { customer: 'cus_9', timeoutMs: 8_000 })
    expect(out).toEqual([{ id: 'p1', customer: 'cus_9' }])
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url.searchParams.get('customer')).toBe('cus_9')
    expect(calls[0].url.searchParams.get('dateCreated[ge]')).toBe('2026-09-16')
  })
})

describe('getCustomerPaymentCreatedFlags', () => {
  it('Andressa/Convictus: PAYMENT_CREATED sem canal para o cliente', async () => {
    handler = () =>
      json({
        data: [
          { event: 'PAYMENT_OVERDUE', enabled: true, smsEnabledForCustomer: true },
          { event: 'PAYMENT_CREATED', enabled: true, emailEnabledForCustomer: false, smsEnabledForCustomer: false, whatsappEnabledForCustomer: false },
        ],
        hasMore: false,
      })
    expect(await getCustomerPaymentCreatedFlags(CRED, 'cus_1')).toEqual({ enabled: true, email: false, sms: false, whatsapp: false, phoneCall: false })
    expect(calls[0].url.pathname).toBe('/v3/customers/cus_1/notifications')
    expect(calls[0].method).toBe('GET')
  })

  it('SMS de cobrança criada ligado → devolve o canal (quem cruza com o cadastro é asaasReachesCustomer)', async () => {
    handler = () => json({ data: [{ event: 'PAYMENT_CREATED', enabled: true, smsEnabledForCustomer: true }], hasMore: false })
    expect(await getCustomerPaymentCreatedFlags(CRED, 'cus_2')).toEqual({ enabled: true, email: false, sms: true, whatsapp: false, phoneCall: false })
  })

  it('cada canal separado; canal de evento desligado ou apagado não conta', async () => {
    handler = () =>
      json({
        data: [
          { event: 'PAYMENT_CREATED', enabled: true, emailEnabledForCustomer: true, phoneCallEnabledForCustomer: true },
          { event: 'PAYMENT_CREATED', enabled: false, whatsappEnabledForCustomer: true },
          { event: 'PAYMENT_CREATED', enabled: true, deleted: true, smsEnabledForCustomer: true },
        ],
        hasMore: false,
      })
    expect(await getCustomerPaymentCreatedFlags(CRED, 'cus_5')).toEqual({ enabled: true, email: true, sms: false, whatsapp: false, phoneCall: true })
  })

  it('evento desligado ou ausente → não avisa', async () => {
    handler = () => json({ data: [{ event: 'PAYMENT_CREATED', enabled: false, emailEnabledForCustomer: true }], hasMore: false })
    expect(await getCustomerPaymentCreatedFlags(CRED, 'cus_3')).toEqual({ enabled: false, email: false, sms: false, whatsapp: false, phoneCall: false })
    handler = () => json({ data: [], hasMore: false })
    expect(await getCustomerPaymentCreatedFlags(CRED, 'cus_3')).toEqual({ enabled: false, email: false, sms: false, whatsapp: false, phoneCall: false })
  })

  it('429 lança AsaasApiError com o status (quem chama para de perguntar)', async () => {
    handler = () => json({ errors: [] }, 429)
    await expect(getCustomerPaymentCreatedFlags(CRED, 'cus_4')).rejects.toMatchObject({ status: 429 })
    await expect(getCustomerPaymentCreatedFlags(CRED, 'cus_4')).rejects.toBeInstanceOf(AsaasApiError)
  })
})

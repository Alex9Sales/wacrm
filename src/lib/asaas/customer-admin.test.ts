import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AsaasApiError, type AsaasCredential } from './collections'
import {
  ADMIN_TIMEOUT_MS,
  countCustomerLinks,
  deleteCustomer,
  getCustomerRaw,
  listCustomersStrict,
  listTotalOf,
  restoreCustomer,
} from './customer-admin'

// O Asaas é falsificado no fetch. Interessa: método e rota certos (DELETE e
// POST …/restore), a URL respeitar ASAAS_BASE_URL, contagem que falha virar
// null (nunca zero: 16/09, limpeza de órfãos) e a chave nunca aparecer em erro.

const SECRET = 'SEGREDO-XYZ-123'
const PROD: AsaasCredential = { apiKey: SECRET, environment: 'production' }

interface Call {
  method: string
  url: URL
  headers: Record<string, string>
  signal: AbortSignal | null | undefined
}

let calls: Call[] = []
let responder: (c: Call) => Response | Promise<Response>

const json = (v: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => v, text: async () => JSON.stringify(v) }) as unknown as Response

beforeEach(() => {
  calls = []
  responder = () => json({})
  vi.stubEnv('ASAAS_BASE_URL', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: new URL(String(input)),
        headers: (init?.headers ?? {}) as Record<string, string>,
        signal: init?.signal,
      }
      calls.push(call)
      return responder(call)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('rotas e métodos', () => {
  it('deleteCustomer → DELETE /v3/customers/{id} na produção, com a chave só no header', async () => {
    responder = () => json({ deleted: true, id: 'cus_000199000001' })
    const r = await deleteCustomer(PROD, 'cus_000199000001')
    expect(r).toEqual({ deleted: true, id: 'cus_000199000001' })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url.href).toBe('https://api.asaas.com/v3/customers/cus_000199000001')
    expect(calls[0].headers.access_token).toBe(SECRET)
    expect(calls[0].url.href).not.toContain(SECRET)
  })

  it('restoreCustomer → POST /v3/customers/{id}/restore', async () => {
    responder = () => json({ id: 'cus_1', deleted: false })
    await restoreCustomer(PROD, 'cus_1')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url.pathname).toBe('/v3/customers/cus_1/restore')
  })

  it('getCustomerRaw devolve o deleted do Asaas', async () => {
    responder = () => json({ id: 'cus_1', deleted: true, externalReference: 'x' })
    const c = await getCustomerRaw(PROD, 'cus_1')
    expect(c.deleted).toBe(true)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url.pathname).toBe('/v3/customers/cus_1')
  })

  it('URL usa ASAAS_BASE_URL quando definido (sem barra dupla)', async () => {
    vi.stubEnv('ASAAS_BASE_URL', 'https://asaas.teste.local/v3/')
    responder = () => json({ deleted: true, id: 'cus_1' })
    await deleteCustomer(PROD, 'cus_1')
    expect(calls[0].url.href).toBe('https://asaas.teste.local/v3/customers/cus_1')
  })

  it('id fora do formato cus_… não vira chamada', async () => {
    await expect(deleteCustomer(PROD, 'cus_1/../payments')).rejects.toBeInstanceOf(AsaasApiError)
    await expect(restoreCustomer(PROD, '')).rejects.toBeInstanceOf(AsaasApiError)
    expect(calls).toHaveLength(0)
  })
})

describe('timeout e erros sem chave', () => {
  it('toda chamada leva AbortSignal.timeout de 20 s', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    responder = () => json({ id: 'cus_1' })
    await getCustomerRaw(PROD, 'cus_1')
    expect(ADMIN_TIMEOUT_MS).toBe(20_000)
    expect(spy).toHaveBeenCalledWith(20_000)
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it('timeout vira AsaasApiError status 0 com "demorou demais"', async () => {
    responder = () => {
      const e = new Error('The operation was aborted due to timeout')
      e.name = 'TimeoutError'
      throw e
    }
    const err = await deleteCustomer(PROD, 'cus_1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AsaasApiError)
    expect((err as AsaasApiError).status).toBe(0)
    expect((err as AsaasApiError).message).toMatch(/demorou demais/)
  })

  it('404 e 429 viram AsaasApiError com o status e SEM a chave, mesmo se o corpo ecoar a chave', async () => {
    responder = () => json({ errors: [{ description: `chave ${SECRET} não encontrada` }] }, 404)
    const e404 = (await getCustomerRaw(PROD, 'cus_1').catch((e: unknown) => e)) as AsaasApiError
    expect(e404).toBeInstanceOf(AsaasApiError)
    expect(e404.status).toBe(404)
    expect(e404.message).toContain('HTTP 404')
    expect(e404.message).not.toContain(SECRET)

    responder = () => json({}, 429)
    const e429 = (await restoreCustomer(PROD, 'cus_1').catch((e: unknown) => e)) as AsaasApiError
    expect(e429.status).toBe(429)
    expect(e429.message).not.toContain(SECRET)
    expect(e429.message).not.toContain('access_token')
  })
})

describe('countCustomerLinks — falha é null, nunca zero', () => {
  it('conta cobranças, assinaturas e notas por customer=id&limit=1, em série', async () => {
    responder = (c) => {
      if (c.url.pathname.endsWith('/payments')) return json({ totalCount: 2, data: [{}], hasMore: true })
      if (c.url.pathname.endsWith('/subscriptions')) return json({ totalCount: 0, data: [], hasMore: false })
      return json({ data: [], hasMore: false })
    }
    const r = await countCustomerLinks(PROD, 'cus_1')
    expect(r).toEqual({ payments: 2, subscriptions: 0, invoices: 0 })
    expect(calls.map((c) => c.url.pathname)).toEqual(['/v3/payments', '/v3/subscriptions', '/v3/invoices'])
    expect(calls.every((c) => c.method === 'GET' && c.url.searchParams.get('customer') === 'cus_1' && c.url.searchParams.get('limit') === '1')).toBe(true)
    expect(calls[1].url.searchParams.has('status')).toBe(false)
  })

  it('429 numa consulta → null só nela', async () => {
    responder = (c) => (c.url.pathname.endsWith('/subscriptions') ? json({}, 429) : json({ totalCount: 0, data: [] }))
    expect(await countCustomerLinks(PROD, 'cus_1')).toEqual({ payments: 0, subscriptions: null, invoices: 0 })
  })

  it('rede fora ou resposta sem totalCount nem data → null', async () => {
    responder = (c) => {
      if (c.url.pathname.endsWith('/payments')) throw new Error('ECONNRESET')
      return json({ ok: true })
    }
    expect(await countCustomerLinks(PROD, 'cus_1')).toEqual({ payments: null, subscriptions: null, invoices: null })
  })

  it('id inválido → tudo null sem chamar', async () => {
    expect(await countCustomerLinks(PROD, 'nada')).toEqual({ payments: null, subscriptions: null, invoices: null })
    expect(calls).toHaveLength(0)
  })

  it('listTotalOf: totalCount inconsistente com data não esconde item', () => {
    expect(listTotalOf({ totalCount: 0, data: [{}], hasMore: false })).toBe(1)
    expect(listTotalOf({ data: [{}], hasMore: true })).toBe(2)
    expect(listTotalOf(null)).toBeNull()
  })
})

describe('listCustomersStrict — lista cortada é avisada', () => {
  it('pagina até hasMore=false → complete', async () => {
    responder = (c) => {
      const offset = Number(c.url.searchParams.get('offset'))
      return json({ data: [{ id: `cus_${offset}` }], hasMore: offset < 100 })
    }
    const r = await listCustomersStrict(PROD, 10)
    expect(r.complete).toBe(true)
    expect(r.customers.map((c) => c.id)).toEqual(['cus_0', 'cus_100'])
    expect(calls.map((c) => c.url.searchParams.get('limit'))).toEqual(['100', '100'])
  })

  it('ainda hasMore no teto → complete:false', async () => {
    responder = () => json({ data: [{ id: 'cus_x' }], hasMore: true })
    const r = await listCustomersStrict(PROD, 3)
    expect(r.complete).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('resposta sem lista lança (não é conta vazia)', async () => {
    responder = () => json({ hasMore: false })
    await expect(listCustomersStrict(PROD, 3)).rejects.toBeInstanceOf(AsaasApiError)
  })
})

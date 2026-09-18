import { describe, expect, it, vi } from 'vitest'

import type { AsaasCredential } from '@/lib/asaas/collections'

import { paymentRefsFrom, paymentRefsPayload, reconferPayments, refsByConnection } from './payment-refs'

const CONTA1 = 'aaaaaaaa-1111-4111-8111-111111111111' // GoLink "Asaas"
const CONTA2 = 'bbbbbbbb-2222-4222-8222-222222222222' // GoLink "AsaasGoLink"

describe('paymentRefsPayload', () => {
  it('uma conta: mantém connectionId (leitor antigo durante o deploy)', () => {
    expect(paymentRefsPayload([{ asaasId: 'pay_A', connectionId: CONTA1 }])).toEqual({
      paymentRefs: [{ asaasId: 'pay_A', connectionId: CONTA1 }],
      asaasIds: ['pay_A'],
      connectionId: CONTA1,
    })
  })

  it('duas contas: sem connectionId único, asaasIds plano na ordem', () => {
    const p = paymentRefsPayload([
      { asaasId: 'pay_A', connectionId: CONTA1 },
      { asaasId: 'pay_B', connectionId: CONTA2 },
    ])
    expect(p.connectionId).toBeUndefined()
    expect(p.asaasIds).toEqual(['pay_A', 'pay_B'])
  })

  it('caso de UMA parcela da conta 2 (a da conta 1 já foi lembrada): conexão certa', () => {
    expect(paymentRefsPayload([{ asaasId: 'pay_B', connectionId: CONTA2 }]).connectionId).toBe(CONTA2)
  })
})

describe('paymentRefsFrom', () => {
  it('formato novo e antigo', () => {
    expect(paymentRefsFrom({ paymentRefs: [{ asaasId: 'pay_A', connectionId: CONTA1 }, { asaasId: 'pay_B', connectionId: CONTA2 }] })).toHaveLength(2)
    expect(paymentRefsFrom({ connectionId: CONTA1, asaasIds: ['pay_A', 'pay_A', 'pay_C'] })).toEqual([
      { asaasId: 'pay_A', connectionId: CONTA1 },
      { asaasId: 'pay_C', connectionId: CONTA1 },
    ])
  })

  it('referência quebrada não reconfere pela metade', () => {
    expect(paymentRefsFrom({ paymentRefs: [{ asaasId: 'pay_A', connectionId: CONTA1 }, { asaasId: 'pay_B' }] })).toEqual([])
    expect(paymentRefsFrom({ asaasIds: ['pay_A'] })).toEqual([])
    expect(paymentRefsFrom({})).toEqual([])
  })

  it('não confunde com summary.items', () => {
    expect(paymentRefsFrom({ items: [{ line: 'x', url: 'y' }], connectionId: CONTA1, asaasIds: ['pay_A'] })).toHaveLength(1)
  })
})

describe('refsByConnection', () => {
  it('agrupa por conta', () => {
    const m = refsByConnection([
      { asaasId: 'pay_A', connectionId: CONTA1 },
      { asaasId: 'pay_B', connectionId: CONTA2 },
      { asaasId: 'pay_C', connectionId: CONTA1 },
    ])
    expect(m.get(CONTA1)).toEqual(['pay_A', 'pay_C'])
    expect(m.get(CONTA2)).toEqual(['pay_B'])
  })
})

describe('reconferPayments — cada parcela com a chave da conta DELA', () => {
  const cred = (key: string): AsaasCredential => ({ apiKey: key, environment: 'production' })
  const credFor = async (id: string) =>
    id === CONTA1 ? { cred: cred('chave-1'), label: 'Asaas' } : id === CONTA2 ? { cred: cred('chave-2'), label: 'AsaasGoLink' } : { error: 'A conta do Asaas deste lembrete não existe mais no CRM.' }

  it('pay_A na conta 1 e pay_B na conta 2', async () => {
    const get = vi.fn(async (c: AsaasCredential, id: string) => {
      const dono = id === 'pay_A' ? 'chave-1' : 'chave-2'
      if (c.apiKey !== dono) throw new Error('O Asaas recusou a consulta (HTTP 404).')
      return { status: 'PENDING' }
    })
    const r = await reconferPayments(
      [{ asaasId: 'pay_A', connectionId: CONTA1 }, { asaasId: 'pay_B', connectionId: CONTA2 }],
      credFor,
      get,
      ['PENDING'],
    )
    expect(r).toEqual({ ok: true, pending: ['pay_A', 'pay_B'] })
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'chave-1' }), 'pay_A')
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'chave-2' }), 'pay_B')
  })

  it('falha numa conta recusa tudo e diz qual conta', async () => {
    const get = vi.fn(async (c: AsaasCredential) => {
      if (c.apiKey === 'chave-2') throw new Error('timeout')
      return { status: 'PENDING' }
    })
    const r = await reconferPayments(
      [{ asaasId: 'pay_A', connectionId: CONTA1 }, { asaasId: 'pay_B', connectionId: CONTA2 }],
      credFor,
      get,
      ['PENDING'],
    )
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('AsaasGoLink')
  })

  it('conta apagada, tudo pago, sem referência', async () => {
    const get = vi.fn(async () => ({ status: 'RECEIVED' }))
    expect(await reconferPayments([{ asaasId: 'pay_X', connectionId: 'outra' }], credFor, get, ['PENDING'])).toEqual({
      ok: false,
      error: 'A conta do Asaas deste lembrete não existe mais no CRM.',
    })
    const pago = await reconferPayments([{ asaasId: 'pay_A', connectionId: CONTA1 }], credFor, get, ['PENDING'])
    expect(!pago.ok && pago.error).toContain('já foi paga')
    expect((await reconferPayments([], credFor, get, ['PENDING'])).ok).toBe(false)
  })
})

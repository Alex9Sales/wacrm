import { describe, it, expect } from 'vitest'

import { getPlan, isPlanKey, formatPrice, PLAN_LIST } from '@/lib/billing/plans'
import { normalizeAsaasKey } from '@/lib/billing/asaas'
import {
  isActivateEvent,
  extractOrgRef,
  addOneMonthISO,
} from '@/lib/billing/webhook'

describe('planos', () => {
  it('resolve os 4 planos e rejeita chave inválida', () => {
    expect(getPlan('start')?.price).toBe(139.9)
    expect(getPlan('pro')?.price).toBe(799)
    expect(getPlan('essencial')?.name).toBe('Essencial')
    expect(getPlan('enterprise')?.price).toBe(1999)
    expect(getPlan('xpto')).toBeNull()
    expect(isPlanKey('pro')).toBe(true)
    expect(isPlanKey('nope')).toBe(false)
    expect(PLAN_LIST).toHaveLength(4)
  })

  it('formata o preço em reais', () => {
    expect(formatPrice(497)).toBe('R$ 497')
    expect(formatPrice(1999)).toBe('R$ 1.999')
  })
})

describe('normalização da chave do Asaas', () => {
  it('garante exatamente um $ inicial (com, sem, ou $$)', () => {
    expect(normalizeAsaasKey('$aact_abc')).toBe('$aact_abc')
    expect(normalizeAsaasKey('aact_abc')).toBe('$aact_abc')
    expect(normalizeAsaasKey('$$aact_abc')).toBe('$aact_abc')
    expect(normalizeAsaasKey('  $aact_abc  ')).toBe('$aact_abc')
  })

  it('vazio/ausente → undefined', () => {
    expect(normalizeAsaasKey('')).toBeUndefined()
    expect(normalizeAsaasKey('   ')).toBeUndefined()
    expect(normalizeAsaasKey(undefined)).toBeUndefined()
    expect(normalizeAsaasKey(null)).toBeUndefined()
  })
})

describe('webhook do Asaas — helpers', () => {
  it('classifica eventos que ativam a conta', () => {
    expect(isActivateEvent('PAYMENT_CONFIRMED')).toBe(true)
    expect(isActivateEvent('PAYMENT_RECEIVED')).toBe(true)
    expect(isActivateEvent('PAYMENT_OVERDUE')).toBe(false)
    expect(isActivateEvent('PAYMENT_CREATED')).toBe(false)
    expect(isActivateEvent(undefined)).toBe(false)
  })

  it('extrai externalReference (org) e a assinatura do payment', () => {
    expect(
      extractOrgRef({ externalReference: 'org-123', subscription: 'sub_1' }),
    ).toEqual({ externalReference: 'org-123', subscriptionId: 'sub_1' })
    expect(extractOrgRef({})).toEqual({
      externalReference: null,
      subscriptionId: null,
    })
    expect(extractOrgRef(null)).toEqual({
      externalReference: null,
      subscriptionId: null,
    })
  })

  it('calcula o próximo vencimento (+1 mês) a partir da data do pagamento', () => {
    expect(addOneMonthISO('2026-08-18').slice(0, 10)).toBe('2026-09-18')
    // data inválida → cai pra agora + 1 mês (só garante que retorna ISO válido).
    expect(Number.isNaN(new Date(addOneMonthISO('lixo')).getTime())).toBe(false)
  })
})

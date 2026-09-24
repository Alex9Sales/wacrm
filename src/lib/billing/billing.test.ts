import { describe, it, expect } from 'vitest'

import { getPlan, isPlanKey, formatPrice, planPriceOf, PLAN_LIST } from '@/lib/billing/plans'
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

// 24/09: o painel de Sucesso mostrava "MRR R$ 0" com 12 assinantes ativos.
// O plano é texto livre no cadastro e as contas reais estão gravadas como
// "Pro", "PRO" e "Enterprise" — nenhuma batia com as chaves minúsculas, e a
// única que entrava na conta era a do "pro" minúsculo (o perdido de R$ 799).
describe('planPriceOf — preço tolerante à caixa do cadastro', () => {
  it('lê os planos como estão gravados nas contas reais', () => {
    expect(planPriceOf('Pro')).toBe(799)
    expect(planPriceOf('PRO')).toBe(799)
    expect(planPriceOf('pro')).toBe(799)
    expect(planPriceOf('Enterprise')).toBe(1999)
    expect(planPriceOf(' Essencial ')).toBe(497)
  })

  it('plano ausente ou desconhecido vale zero, sem quebrar a soma', () => {
    expect(planPriceOf(null)).toBe(0)
    expect(planPriceOf(undefined)).toBe(0)
    expect(planPriceOf('')).toBe(0)
    expect(planPriceOf('Plano Ouro')).toBe(0)
  })

  it('o MRR das contas ativas de hoje deixa de ser zero', () => {
    // 7 "Pro" + 2 "PRO" + 2 "Enterprise" = o que o painel deveria mostrar.
    const contas = ['Pro', 'Pro', 'Pro', 'Pro', 'Pro', 'Pro', 'Pro', 'PRO', 'PRO', 'Enterprise', 'Enterprise']
    expect(contas.reduce((s, p) => s + planPriceOf(p), 0)).toBe(11189)
  })
})

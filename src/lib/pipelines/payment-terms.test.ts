import { describe, expect, it } from 'vitest'

import { normalizePaymentTerms, paymentTermsChips, paymentTermsSummary } from './payment-terms'

describe('condições de pagamento do negócio (Rafael, 08/09)', () => {
  it('recorrente guarda a recorrência e ignora parcelas', () => {
    expect(normalizePaymentTerms({ paymentType: 'recurring', recurrence: 'monthly', installments: 3, paymentMethod: 'pix' })).toEqual({
      paymentType: 'recurring',
      recurrence: 'monthly',
      installments: null,
      paymentMethod: 'pix',
    })
    expect(paymentTermsChips({ paymentType: 'recurring', recurrence: 'monthly', paymentMethod: 'pix' })).toEqual(['Recorrente · mensal', 'Pix'])
    expect(paymentTermsSummary({ paymentType: 'recurring', recurrence: 'monthly', paymentMethod: 'pix' })).toBe('Recorrente (mensal) · Pix')
  })
  it('à vista aceita parcelas 2–60 e recusa recorrência', () => {
    expect(normalizePaymentTerms({ paymentType: 'single', recurrence: 'monthly', installments: '3', paymentMethod: 'credit_card' })).toEqual({
      paymentType: 'single',
      recurrence: null,
      installments: 3,
      paymentMethod: 'credit_card',
    })
    expect(paymentTermsChips({ paymentType: 'single', installments: 3, paymentMethod: 'credit_card' })).toEqual(['3x', 'Cartão de crédito'])
    expect(paymentTermsSummary({ paymentType: 'single', installments: 3, paymentMethod: 'credit_card' })).toBe('À vista em 3x · Cartão de crédito')
    expect(normalizePaymentTerms({ paymentType: 'single', installments: 1 }).installments).toBeNull()
    expect(normalizePaymentTerms({ paymentType: 'single', installments: 99 }).installments).toBeNull()
  })
  it('lixo vira null e sem nada não tem selo', () => {
    expect(normalizePaymentTerms({ paymentType: 'x', recurrence: 'y', installments: 'abc', paymentMethod: 'z' })).toEqual({
      paymentType: null,
      recurrence: null,
      installments: null,
      paymentMethod: null,
    })
    expect(paymentTermsChips(null)).toEqual([])
    expect(paymentTermsSummary(undefined)).toBeNull()
  })
})

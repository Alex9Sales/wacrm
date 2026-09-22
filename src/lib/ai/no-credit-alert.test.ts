import { describe, expect, it } from 'vitest'

import { isNoCreditError } from './no-credit-alert'

describe('isNoCreditError — só a falta de saldo liga o alerta', () => {
  it('reconhece o texto que a OpenAI devolveu na Família do Gás (22/09)', () => {
    const err = new Error(
      'OpenAI rate limit reached: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
    )
    expect(isNoCreditError(err)).toBe(true)
  })

  it('reconhece as outras formas do mesmo erro', () => {
    expect(isNoCreditError(new Error('429 insufficient_quota'))).toBe(true)
    expect(isNoCreditError(new Error('You exceeded your current quota, please check your plan'))).toBe(true)
    expect(isNoCreditError('You have NO CREDITS REMAINING')).toBe(true)
  })

  it('não confunde com limite de velocidade, chave errada ou queda', () => {
    expect(isNoCreditError(new Error('Rate limit reached for gpt-5.6-luna: too many requests'))).toBe(false)
    expect(isNoCreditError(new Error('Incorrect API key provided'))).toBe(false)
    expect(isNoCreditError(new Error('fetch failed'))).toBe(false)
    expect(isNoCreditError(new Error(''))).toBe(false)
    expect(isNoCreditError(null)).toBe(false)
    expect(isNoCreditError(undefined)).toBe(false)
  })
})

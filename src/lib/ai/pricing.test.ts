import { describe, it, expect } from 'vitest'

import { priceForModel, costUsd, toBrl } from './pricing'

describe('priceForModel — casamento por prefixo', () => {
  it('resolve pelo prefixo conhecido mais longo (com sufixo de data)', () => {
    // "gpt-4o-mini-*" tem que bater em gpt-4o-mini, não no gpt-4o mais curto.
    const mini = priceForModel('gpt-4o-mini-2024-07-18')
    expect(mini.known).toBe(true)
    expect(mini.price.input).toBe(0.15)

    const full = priceForModel('gpt-4o-2024-11-20')
    expect(full.known).toBe(true)
    expect(full.price.input).toBe(2.5)

    const sonnet = priceForModel('claude-3-5-sonnet-20241022')
    expect(sonnet.known).toBe(true)
    expect(sonnet.price.output).toBe(15)
  })

  it('modelo desconhecido cai no fallback (nunca zera o custo)', () => {
    const unknown = priceForModel('algum-modelo-novo-2027')
    expect(unknown.known).toBe(false)
    expect(unknown.price.input).toBeGreaterThan(0)
    expect(unknown.price.output).toBeGreaterThan(0)
  })
})

describe('costUsd — fatiamento cache/não-cache', () => {
  it('OpenAI: prompt inclui cached (subconjunto descontado)', () => {
    // gpt-4o-mini: input 0.15, cachedInput 0.075, output 0.6 (US$/1M).
    // prompt=100 (40 cache), completion=20 → nonCached=60.
    // (60*0.15 + 40*0.075 + 20*0.6) / 1e6 = (9 + 3 + 12)/1e6 = 24e-6.
    const usd = costUsd('gpt-4o-mini', {
      promptTokens: 100,
      completionTokens: 20,
      cachedReadTokens: 40,
      cacheCreationTokens: 0,
    })
    expect(usd).toBeCloseTo(24e-6, 12)
  })

  it('Anthropic: cache_read barato + cache_creation premium', () => {
    // claude-3-5-sonnet: input 3, cachedInput 0.3, cacheWrite 3.75, output 15.
    // prompt=85 (30 read, 5 write) → nonCached=50.
    // (50*3 + 30*0.3 + 5*3.75 + 10*15)/1e6 = (150 + 9 + 18.75 + 150)/1e6.
    const usd = costUsd('claude-3-5-sonnet-20241022', {
      promptTokens: 85,
      completionTokens: 10,
      cachedReadTokens: 30,
      cacheCreationTokens: 5,
    })
    expect(usd).toBeCloseTo(327.75e-6, 12)
  })

  it('uso zerado custa zero', () => {
    expect(
      costUsd('gpt-4o', {
        promptTokens: 0,
        completionTokens: 0,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBe(0)
  })
})

describe('toBrl', () => {
  it('converte US$→R$ com o câmbio default (5.40) quando env ausente', () => {
    const prev = process.env.USD_BRL_RATE
    delete process.env.USD_BRL_RATE
    expect(toBrl(2)).toBeCloseTo(10.8, 10)
    if (prev !== undefined) process.env.USD_BRL_RATE = prev
  })

  it('usa USD_BRL_RATE quando definido e válido', () => {
    const prev = process.env.USD_BRL_RATE
    process.env.USD_BRL_RATE = '6'
    expect(toBrl(2)).toBeCloseTo(12, 10)
    if (prev === undefined) delete process.env.USD_BRL_RATE
    else process.env.USD_BRL_RATE = prev
  })
})

import { describe, expect, it } from 'vitest'

import { maxSimilarity, seedFrom, textSimilarity, tooSimilar, variationPlan } from './variation'

const a =
  'Oi, Ana! Passando para lembrar de um valor em aberto por aqui: R$ 150,00 · venceu em 01/08 (40 dias de atraso). Para pagar: https://x/1. Se já pagou ou quiser combinar uma data, é só me dizer por aqui.'
const b =
  'Ana, tudo bem? Ficou uma parcela pendente de R$ 150,00, vencida em 01/08. O link para pagamento é https://x/1 — se já resolveu, me avisa; se quiser combinar uma data, a gente vê junto.'

describe('textSimilarity — o que conta como repetição', () => {
  it('texto igual = 1; texto diferente sobre a mesma dívida fica abaixo do limiar', () => {
    expect(textSimilarity(a, a)).toBe(1)
    expect(textSimilarity(a, b)).toBeLessThan(0.5)
  })

  it('valores, datas e link não contam: mudar só os números continua sendo cópia', () => {
    const soNumeros = a.replace('150,00', '980,00').replace('01/08', '15/08').replace('https://x/1', 'https://x/9').replace('40 dias', '12 dias')
    expect(textSimilarity(a, soNumeros)).toBe(1)
  })

  it('tooSimilar/maxSimilarity olham a pior das anteriores', () => {
    expect(tooSimilar(a, [b])).toBe(false)
    expect(tooSimilar(a, [b, a])).toBe(true)
    expect(maxSimilarity(a, [b, a])).toBe(1)
    expect(tooSimilar(a, [])).toBe(false)
  })
})

describe('seedFrom + variationPlan — sorteio determinístico', () => {
  it('mesma semente, mesmo plano; toque diferente, plano (quase sempre) diferente', () => {
    const s1 = seedFrom('contato-1', 0, '2026-09-05')
    expect(seedFrom('contato-1', 0, '2026-09-05')).toBe(s1)
    expect(variationPlan(s1)).toEqual(variationPlan(s1))
    const planos = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((t) => JSON.stringify(variationPlan(seedFrom('contato-1', t, '2026-09-05')))))
    expect(planos.size).toBeGreaterThanOrEqual(5)
  })

  it('dois devedores no mesmo dia não recebem o mesmo jeito', () => {
    const planos = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((c) => JSON.stringify(variationPlan(seedFrom(c, 0, '2026-09-05')))))
    expect(planos.size).toBeGreaterThanOrEqual(4)
  })
})

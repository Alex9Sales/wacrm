import { describe, expect, it } from 'vitest'

import { seedFromId, thankYouMessage } from './thanks-text'

describe('thankYouMessage', () => {
  it('agradece com nome e valor, sem link e sem pedir nada', () => {
    const t = thankYouMessage('Renato', 150, 0)
    expect(t).toMatch(/Renato/)
    expect(t).toMatch(/150,00/)
    expect(t).toMatch(/[Oo]brigad/)
    expect(t).not.toMatch(/http|pagar|link/i)
  })
  it('varia pela semente e funciona sem nome/valor', () => {
    const a = thankYouMessage(null, 0, 0)
    const b = thankYouMessage(null, 0, 1)
    expect(a).not.toBe(b)
    expect(a).not.toMatch(/R\$/)
    expect(a).not.toMatch(/,\s*\./)
  })
  it('semente estável por id', () => {
    expect(seedFromId('abc')).toBe(seedFromId('abc'))
    expect(seedFromId('abc')).not.toBe(seedFromId('abd'))
  })
})

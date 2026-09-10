import { describe, expect, it } from 'vitest'

import { looksLikeBareCode } from './bare-code'

const PIX =
  '00020126580014BR.GOV.BCB.PIX0136123e4567-e89b-12d3-a456-4266554400005204000053039865406500.005802BR5913GOLINK GESTAO6009SAO PAULO62070503***63041D3D'

describe('looksLikeBareCode', () => {
  it('Pix copia e cola (EMV) é código', () => {
    expect(looksLikeBareCode(PIX)).toBe(true)
    expect(looksLikeBareCode(`  ${PIX}\n`)).toBe(true)
  })

  it('linha digitável de boleto e de convênio são código', () => {
    expect(looksLikeBareCode('23793.38128 60007.827136 95000.063305 9 84660000012345')).toBe(true)
    expect(looksLikeBareCode('846700000017 435901090010 060412215809 400000000000')).toBe(true)
  })

  it('link sozinho é código', () => {
    expect(looksLikeBareCode('https://www.asaas.com/i/zlp8zxalwwoavsd7')).toBe(true)
  })

  it('texto de gente NÃO é código', () => {
    expect(looksLikeBareCode('Oi Hudson, tudo bem? Segue o Pix pra recarga.')).toBe(false)
    expect(looksLikeBareCode(`Segue o código:\n${PIX}`)).toBe(false)
    expect(looksLikeBareCode('Meu telefone: 11 97690-5279')).toBe(false)
    expect(looksLikeBareCode('12345')).toBe(false)
    expect(looksLikeBareCode('')).toBe(false)
    expect(looksLikeBareCode(null)).toBe(false)
  })
})

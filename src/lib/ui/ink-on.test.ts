import { describe, it, expect } from 'vitest'

import { inkOn, luminance } from './ink-on'

// ------------------------------------------------------------
// Contraste do chip da Agenda. O texto era SEMPRE branco por cima da cor da
// agenda — e agenda em tom claro virava branco no claro. 17/09, João da
// GoLink: "esse azul-céu fica invisível praticamente na letra branca".
// ------------------------------------------------------------

describe('inkOn', () => {
  it('põe texto escuro nas cores claras — o caso do João', () => {
    expect(inkOn('#7dd3fc')).toBe('#15181d') // azul-céu do Google
    expect(inkOn('#fde047')).toBe('#15181d') // amarelo
    expect(inkOn('#a7f3d0')).toBe('#15181d') // verde-água
    expect(inkOn('#ffffff')).toBe('#15181d')
  })

  it('mantém branco nas cores escuras (o que já funcionava)', () => {
    expect(inkOn('#6366f1')).toBe('#ffffff') // índigo padrão das agendas
    expect(inkOn('#3b82f6')).toBe('#ffffff') // azul das etapas
    expect(inkOn('#000000')).toBe('#ffffff')
  })

  it('aceita hex de 3 dígitos e com/sem #', () => {
    expect(inkOn('#ff0')).toBe('#15181d')
    expect(inkOn('fff')).toBe('#15181d')
    expect(inkOn('  #7DD3FC  ')).toBe('#15181d')
  })

  it('cor inválida ou vazia cai no branco, como era antes', () => {
    expect(inkOn(null)).toBe('#ffffff')
    expect(inkOn(undefined)).toBe('#ffffff')
    expect(inkOn('')).toBe('#ffffff')
    expect(inkOn('rgb(120,200,255)')).toBe('#ffffff')
  })

  it('luminância: preto 0, branco 1', () => {
    expect(luminance('#000000')).toBeCloseTo(0, 5)
    expect(luminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

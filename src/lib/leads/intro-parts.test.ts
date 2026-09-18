import { describe, it, expect } from 'vitest'
import { splitIntroParts } from './intro-parts'

describe('splitIntroParts', () => {
  it('splits on a line with only ---', () => {
    expect(splitIntroParts('Oi, Ana! 👋\n---\nVi seu interesse.\n---\nO que te motivou?\na) x\nb) y')).toEqual([
      'Oi, Ana! 👋',
      'Vi seu interesse.',
      'O que te motivou?\na) x\nb) y',
    ])
  })

  it('keeps a single message and blank lines inside a part', () => {
    expect(splitIntroParts('Linha 1\n\nLinha 2')).toEqual(['Linha 1\n\nLinha 2'])
  })

  it('ignores spaces around the separator and a trailing one', () => {
    expect(splitIntroParts('A\n  ---  \nB\n---')).toEqual(['A', 'B'])
  })

  it('does not split on dashes inside text', () => {
    expect(splitIntroParts('franquia — que ótimo --- sério')).toEqual(['franquia — que ótimo --- sério'])
  })
})

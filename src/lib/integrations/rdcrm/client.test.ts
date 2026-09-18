import { describe, it, expect } from 'vitest'
import { rdActivityText } from './client'

describe('rdActivityText', () => {
  it('tira acento, cedilha e travessão — o /activities do RD grava torto', () => {
    expect(rdActivityText('Ganho via FluxiaCRM — IA marcou a reunião para segunda-feira, 21/09, às 9h.')).toBe(
      'Ganho via FluxiaCRM - IA marcou a reuniao para segunda-feira, 21/09, as 9h.',
    )
    expect(rdActivityText('Serviço – orçamento de ÁREA ÚTIL')).toBe('Servico - orcamento de AREA UTIL')
  })

  it('mantém quebra de linha e some com emoji', () => {
    expect(rdActivityText('Linha 1\nLinha 2 📅')).toBe('Linha 1\nLinha 2 ')
  })

  it('texto já sem acento passa igual', () => {
    expect(rdActivityText('Ganho via FluxiaCRM.')).toBe('Ganho via FluxiaCRM.')
  })
})

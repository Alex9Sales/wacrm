import { describe, expect, it } from 'vitest'

import { plainAiText } from './plain-text'

// 15/09 (Alex): o balão mostrava "- **Valor:** R$ 100,00" com os asteriscos crus.
describe('plainAiText', () => {
  it('tira o negrito da descrição do comprovante', () => {
    const descricao = [
      'A imagem é um comprovante de pagamento com as seguintes informações:',
      '',
      '- **Valor:** R$ 100,00',
      '- **Pagador:** EMPRESA EXEMPLO LTDA',
      '- **Código de barras:** 23790.00009 12345.678901 23456.789012 1 00000000010000',
    ].join('\n')
    expect(plainAiText(descricao)).toBe(
      [
        'A imagem é um comprovante de pagamento com as seguintes informações:',
        '',
        '- Valor: R$ 100,00',
        '- Pagador: EMPRESA EXEMPLO LTDA',
        '- Código de barras: 23790.00009 12345.678901 23456.789012 1 00000000010000',
      ].join('\n'),
    )
  })

  it('tira títulos, itálico, sublinhado e código', () => {
    expect(plainAiText('### Comprovante\nPago *hoje* por __Pix__ com `id 123`')).toBe('Comprovante\nPago hoje por Pix com id 123')
  })

  it('não mexe em asterisco que não é marcação', () => {
    expect(plainAiText('Etiqueta: 5 * 3 = 15')).toBe('Etiqueta: 5 * 3 = 15')
    expect(plainAiText('Placa ABC*1234')).toBe('Placa ABC*1234')
  })

  it('some com ** que ficou sem par', () => {
    expect(plainAiText('**Valor: R$ 10')).toBe('Valor: R$ 10')
  })

  it('texto sem marcação passa igual', () => {
    const t = 'Foto de um botijão P-13 azul na calçada.'
    expect(plainAiText(t)).toBe(t)
  })
})

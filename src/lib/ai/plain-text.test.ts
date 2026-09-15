import { describe, expect, it } from 'vitest'

import { plainAiText } from './plain-text'

// 15/09 (Alex): o balão mostrava "- **Valor:** R$ 936,13" com os asteriscos crus.
describe('plainAiText', () => {
  it('tira o negrito da descrição do comprovante', () => {
    const descricao = [
      'A imagem é um comprovante de pagamento com as seguintes informações:',
      '',
      '- **Valor:** R$ 936,13',
      '- **Pagador:** DANYELA GLEYCE LEITE DE SOUZA LTDA',
      '- **Código de barras:** 23792372056001261551813023760005515690000093613',
    ].join('\n')
    expect(plainAiText(descricao)).toBe(
      [
        'A imagem é um comprovante de pagamento com as seguintes informações:',
        '',
        '- Valor: R$ 936,13',
        '- Pagador: DANYELA GLEYCE LEITE DE SOUZA LTDA',
        '- Código de barras: 23792372056001261551813023760005515690000093613',
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

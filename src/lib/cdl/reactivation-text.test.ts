import { describe, it, expect } from 'vitest'
import { reactivationText } from './reactivation-text'

// Produto como o ERP grava ("1.00x P-13 UltraGaz  Ultragaz"); nomes fictícios.
const P13 = '1.00x P-13 UltraGaz  Ultragaz'

describe('reactivationText', () => {
  it('recompra atrasada NÃO fala em dias nem ciclo — é dado interno', () => {
    const t = reactivationText('Vanessa Lima', 'repurchase_overdue', P13)
    expect(t).toBe('Oi Vanessa! 😊 Passando pra saber se já está precisando de P-13 Ultragaz de novo. Se precisar, consigo te atender hoje.')
    expect(t).not.toMatch(/\d+\s*dias?/)
  })

  it('sem produto no histórico não fica "precisando de seu pedido"', () => {
    expect(reactivationText('Vanessa', 'repurchase_overdue', null)).toBe(
      'Oi Vanessa! 😊 Passando pra saber se posso te ajudar com um novo pedido. Se precisar, consigo te atender hoje.',
    )
    expect(reactivationText(null, 'inactive', null)).toBe(
      'Oi! Sumiu, hein 😄 Faz um tempo que não passa aqui. Posso te ajudar com alguma coisa hoje?',
    )
  })

  it('na hora da recompra e cliente sumido seguem o tom de sempre', () => {
    expect(reactivationText('Vanessa', 'repurchase_due', P13)).toBe(
      'Oi Vanessa! Passando pra ver se tá na hora de repor o P-13 Ultragaz. Quer que eu já deixe separado? 😊',
    )
    expect(reactivationText('Vanessa', 'inactive', P13)).toBe(
      'Oi Vanessa! Sumiu, hein 😄 Faz um tempo que não passa aqui. Tá precisando de P-13 Ultragaz? Consigo te atender rapidinho.',
    )
  })
})

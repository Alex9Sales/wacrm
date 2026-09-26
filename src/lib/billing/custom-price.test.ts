import { describe, expect, it } from 'vitest'
import { priceLabelFor } from './custom-price'
import { PLANS } from './plans'

// 26/09 — o caso real: cliente da revendedora fechou o Start a R$ 139,90 no
// semestral, enquanto o Start de tabela vai para R$ 297 em dezembro.

describe('valor negociado x tabela', () => {
  it('sem valor digitado, vale a tabela do plano', () => {
    const r = priceLabelFor('start', null)
    expect(r.price).toBe(PLANS.start.price)
    expect(r.custom).toBe(false)
    expect(r.differs).toBe(false)
  })

  it('valor digitado vence a tabela — é o que o cliente paga', () => {
    const r = priceLabelFor('pro', 139.9)
    expect(r.price).toBe(139.9)
    expect(r.custom).toBe(true)
    expect(r.differs).toBe(true)
    expect(r.listPrice).toBe(PLANS.pro.price)
  })

  it('digitado IGUAL à tabela continua sendo negociado', () => {
    // O ponto: quando a tabela subir, este cliente fica no valor dele. Se
    // marcássemos só quem difere hoje, ele sumiria da lista de negociados
    // justamente até o dia em que o preço muda.
    const r = priceLabelFor('start', PLANS.start.price)
    expect(r.custom).toBe(true)
    expect(r.differs).toBe(false)
  })

  it('139.9 e 139.90 são o mesmo preço', () => {
    const r = priceLabelFor('start', 139.90)
    expect(r.differs).toBe(false)
  })
})

describe('não inventa valor', () => {
  it('zero e negativo não são valor contratado', () => {
    expect(priceLabelFor('start', 0).custom).toBe(false)
    expect(priceLabelFor('start', -10).custom).toBe(false)
  })

  it('plano desconhecido não quebra — some sem preço de tabela', () => {
    const r = priceLabelFor('plano-que-nao-existe', null)
    expect(r.listPrice).toBe(0)
    expect(r.custom).toBe(false)
  })

  it('plano nulo com valor digitado ainda mostra o negociado', () => {
    const r = priceLabelFor(null, 850)
    expect(r.price).toBe(850)
    expect(r.custom).toBe(true)
    expect(r.differs).toBe(true)
  })
})

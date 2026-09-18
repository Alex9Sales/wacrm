import { describe, expect, it } from 'vitest'

import { pickDealToReuse } from './close-actions'

const H = 60 * 60 * 1000
// Comprador da Família do Gás: 1º card 14/09 10:22 (Campo Grande), arrastado pra
// Ganho em 13 min; pagou e a IA "fechou" de novo às 20:07.
const primeiroCard = { id: 'card-1', status: 'won', createdAt: '2026-09-14T14:22:00.000Z' }
const quandoPagou = new Date('2026-09-15T00:07:00.000Z').getTime()

describe('pickDealToReuse — card da mesma conversa', () => {
  it('comprador de 14/09: card já GANHO 9h45 antes, mesma conversa → reaproveita (não nasce o 2º card)', () => {
    expect(pickDealToReuse({ now: quandoPagou, conversationDeals: [primeiroCard], contactOpenDeals: [] })).toEqual({
      dealId: 'card-1',
      reuse: 'conversation',
    })
  })

  it('card aberto da conversa vale em qualquer idade', () => {
    const aberto = { id: 'a', status: 'open', createdAt: '2026-08-01T10:00:00.000Z' }
    expect(pickDealToReuse({ now: quandoPagou, conversationDeals: [aberto], contactOpenDeals: [] })?.dealId).toBe('a')
  })

  it('compra de amanhã na mesma conversa (fora das 10 h) → card novo (cliente que compra todo dia)', () => {
    const ontem = { id: 'ontem', status: 'won', createdAt: new Date(quandoPagou - 11 * H).toISOString() }
    expect(pickDealToReuse({ now: quandoPagou, conversationDeals: [ontem], contactOpenDeals: [] })).toBeNull()
  })
})

describe('pickDealToReuse — mesmo cliente, outra conversa', () => {
  it('card ABERTO do contato no mesmo funil → anexa (cliente voltou por outro anúncio)', () => {
    expect(pickDealToReuse({ now: quandoPagou, conversationDeals: [], contactOpenDeals: [{ id: 'lead' }] })).toEqual({
      dealId: 'lead',
      reuse: 'contact',
    })
  })

  it('sem card aberto do contato no funil → card novo', () => {
    expect(pickDealToReuse({ now: quandoPagou, conversationDeals: [], contactOpenDeals: [] })).toBeNull()
  })

  it('a conversa manda antes do contato', () => {
    expect(
      pickDealToReuse({ now: quandoPagou, conversationDeals: [primeiroCard], contactOpenDeals: [{ id: 'lead' }] })?.dealId,
    ).toBe('card-1')
  })
})

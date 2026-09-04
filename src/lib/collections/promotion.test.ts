import { describe, expect, it } from 'vitest'

import { COLLECTION_PROMOTION, evaluatePromotion, promotionHeadline, type PromotionStats } from './promotion'

function stats(p: Partial<PromotionStats> = {}): PromotionStats {
  return { decisions: 0, cleanApprovals: 0, edited: 0, rejected: 0, badOutcomes: 0, spanDays: 0, ...p }
}

/** Histórico que cumpre tudo: 20 decisões, 19 limpas, 1 recusa, 14 dias. */
const bom = stats({ decisions: 20, cleanApprovals: 19, edited: 0, rejected: 1, badOutcomes: 0, spanDays: 14 })

describe('portão de promoção — autonomia por evidência', () => {
  it('libera quando todos os critérios são cumpridos', () => {
    const v = evaluatePromotion(bom)
    expect(v.ready).toBe(true)
    expect(v.blockers).toEqual([])
  })

  it('não libera por quantidade sem tempo — 20 cliques numa tarde não é histórico', () => {
    const v = evaluatePromotion({ ...bom, spanDays: 1 })
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toContain('not_enough_time')
  })

  it('não libera por tempo sem quantidade', () => {
    const v = evaluatePromotion(stats({ decisions: 4, cleanApprovals: 4, spanDays: 60 }))
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toContain('not_enough_decisions')
  })

  it('UMA reversão é eliminatória, mesmo com todo o resto perfeito', () => {
    const v = evaluatePromotion({ ...bom, badOutcomes: 1 })
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toContain('bad_outcomes')
    // E não pode parecer "quase lá".
    expect(v.progress).toBe(0)
  })

  it('texto editado conta contra: reescrever é a IA escrevendo mal', () => {
    const v = evaluatePromotion(stats({ decisions: 20, cleanApprovals: 10, edited: 10, spanDays: 30 }))
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toContain('low_clean_approval')
  })

  it('recusa demais barra mesmo com o resto no lugar', () => {
    const v = evaluatePromotion(stats({ decisions: 20, cleanApprovals: 18, rejected: 2, spanDays: 30 }))
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toContain('too_many_rejections')
  })

  it('sem histórico nenhum, o que falta é histórico — não qualidade', () => {
    const v = evaluatePromotion(stats())
    expect(v.ready).toBe(false)
    const codes = v.blockers.map((b) => b.code)
    expect(codes).toContain('not_enough_decisions')
    expect(codes).not.toContain('low_clean_approval')
    expect(codes).not.toContain('too_many_rejections')
  })

  it('o progresso é o PIOR critério, não a média — senão parece perto sem estar', () => {
    // Quantidade cheia, tempo pela metade.
    const v = evaluatePromotion(stats({ decisions: 20, cleanApprovals: 20, spanDays: 7 }))
    expect(v.progress).toBeCloseTo(0.5, 1)
  })

  it('os limiares são os recalibrados pelo volume real, não os 50 do palpite', () => {
    expect(COLLECTION_PROMOTION.minDecisions).toBe(20)
    expect(COLLECTION_PROMOTION.minDays).toBe(14)
    expect(COLLECTION_PROMOTION.maxBadOutcomes).toBe(0)
  })
})

describe('promotionHeadline', () => {
  it('conta o primeiro impedimento, não um genérico', () => {
    expect(promotionHeadline(evaluatePromotion({ ...bom, spanDays: 3 }))).toContain('dias de uso')
  })

  it('sem histórico convida a usar, em vez de acusar', () => {
    expect(promotionHeadline(evaluatePromotion(stats()))).toContain('Ainda não há histórico')
  })

  it('quando libera, deixa claro que a decisão continua sendo do humano', () => {
    expect(promotionHeadline(evaluatePromotion(bom))).toContain('Você decide')
  })
})

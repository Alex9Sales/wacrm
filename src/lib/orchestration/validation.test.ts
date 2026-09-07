import { describe, expect, it } from 'vitest'

import { COLLECTION_PROMOTION, evaluatePromotion } from '@/lib/collections/promotion'

import {
  confidenceRate,
  criteriaFor,
  DEFAULT_CRITERIA,
  DEFAULT_CRITERIA_BY_ACTION,
  gateApplies,
  nextPromotedAt,
  readPromotedAt,
  sanitizePromotedAt,
  readPromotionOverride,
  sanitizePromotionOverride,
  statsFromCounts,
  statsFromFeedback,
  validationStatus,
} from './validation'

describe('criteriaFor', () => {
  it('usa o padrão POR AÇÃO quando existe, senão o do tipo', () => {
    expect(criteriaFor('send_followup')).toEqual(DEFAULT_CRITERIA_BY_ACTION.send_followup)
    expect(criteriaFor('move_deal')).toEqual(DEFAULT_CRITERIA_BY_ACTION.move_deal)
    expect(criteriaFor('notify_seller')).toEqual(DEFAULT_CRITERIA.notify)
    expect(criteriaFor('pause_cadence')).toEqual(DEFAULT_CRITERIA.crm)
  })
  it('ação rara tem portão possível: proposta 8 decisões em 30 dias; reativação em leva: 30 em 7', () => {
    expect(criteriaFor('draft_proposal').minDecisions).toBe(8)
    expect(criteriaFor('draft_proposal').minDays).toBe(30)
    expect(criteriaFor('reactivation').minDecisions).toBe(30)
    expect(criteriaFor('reactivation').minDays).toBe(7)
  })
  it('cobrança tem o critério próprio (mais duro)', () => {
    expect(criteriaFor('collect_charges')).toEqual(COLLECTION_PROMOTION)
  })
  it('override da conta cobre só as chaves informadas', () => {
    const c = criteriaFor('send_followup', { minDecisions: 5, minDays: 3 })
    expect(c.minDecisions).toBe(5)
    expect(c.minDays).toBe(3)
    expect(c.minCleanApprovalRate).toBe(DEFAULT_CRITERIA_BY_ACTION.send_followup!.minCleanApprovalRate)
  })
  it('dinheiro e cobrança NUNCA toleram reversão, mesmo com override', () => {
    expect(criteriaFor('collect_charges', { maxBadOutcomes: 3 }).maxBadOutcomes).toBe(0)
    expect(criteriaFor('apply_discount', { maxBadOutcomes: 3 }).maxBadOutcomes).toBe(0)
    expect(criteriaFor('move_deal', { maxBadOutcomes: 3 }).maxBadOutcomes).toBe(3)
  })
})

describe('sanitizePromotionOverride / readPromotionOverride', () => {
  it('aceita números válidos (inclusive como string) e descarta lixo', () => {
    expect(sanitizePromotionOverride({ minDecisions: '15', minDays: 7, minCleanApprovalRate: 0.8, maxRejectionRate: 2, maxBadOutcomes: -1, xpto: 1 })).toEqual({
      minDecisions: 15,
      minDays: 7,
      minCleanApprovalRate: 0.8,
    })
  })
  it('sem nada válido devolve null (conta fica no padrão)', () => {
    expect(sanitizePromotionOverride({ minDecisions: 'abc' })).toBeNull()
    expect(sanitizePromotionOverride(null)).toBeNull()
    expect(readPromotionOverride({ actions: { send_followup: 'auto' } })).toBeNull()
  })
  it('lê o override guardado no jsonb autonomy', () => {
    expect(readPromotionOverride({ promotion: { minDecisions: 8 } })).toEqual({ minDecisions: 8 })
  })
})

describe('statsFromFeedback', () => {
  it('reversão e resultado ruim contam como ERRO, não como decisão', () => {
    const s = statsFromFeedback([
      { decision: 'approved', createdAt: '2026-09-01T10:00:00Z' },
      { decision: 'edited', createdAt: '2026-09-03T10:00:00Z' },
      { decision: 'rejected', createdAt: '2026-09-05T10:00:00Z' },
      { decision: 'reversed', createdAt: '2026-09-06T10:00:00Z' },
      { decision: 'bad_result', createdAt: '2026-09-08T10:00:00Z' },
    ])
    expect(s.decisions).toBe(3)
    expect(s.cleanApprovals).toBe(1)
    expect(s.edited).toBe(1)
    expect(s.rejected).toBe(1)
    expect(s.badOutcomes).toBe(2)
    expect(s.criticalBadOutcomes).toBe(1)
    // do dia 01 ao dia 08 (a reversão conta pro intervalo de uso)
    expect(s.spanDays).toBe(7)
  })
  it('resultado ruim é eliminatório mesmo com tolerância a desfeitas configurada', () => {
    const base = { decisions: 40, cleanApprovals: 39, edited: 1, rejected: 0, spanDays: 20 }
    const tolerante = { ...criteriaFor('move_deal'), maxBadOutcomes: 3 }
    // 2 desfeitas dentro da tolerância → passa
    expect(evaluatePromotion({ ...base, badOutcomes: 2, criticalBadOutcomes: 0 }, tolerante).ready).toBe(true)
    // 1 resultado ruim → bloqueia, com o código próprio e progresso zero
    const v = evaluatePromotion({ ...base, badOutcomes: 1, criticalBadOutcomes: 1 }, tolerante)
    expect(v.ready).toBe(false)
    expect(v.blockers.map((b) => b.code)).toEqual(['critical_bad_result'])
    expect(v.progress).toBe(0)
    // 4 desfeitas acima da tolerância → bloqueia por desfeitas
    expect(evaluatePromotion({ ...base, badOutcomes: 4, criticalBadOutcomes: 0 }, tolerante).blockers.map((b) => b.code)).toEqual(['bad_outcomes'])
  })
  it('sem histórico tudo zera e o portão bloqueia por falta de decisões', () => {
    const s = statsFromFeedback([])
    expect(s).toEqual({ decisions: 0, cleanApprovals: 0, edited: 0, rejected: 0, badOutcomes: 0, criticalBadOutcomes: 0, spanDays: 0 })
    const v = evaluatePromotion(s, criteriaFor('send_followup'))
    expect(v.ready).toBe(false)
    expect(v.blockers[0]?.code).toBe('not_enough_decisions')
  })
  it('statsFromCounts: uma decisão só = 0 dias de intervalo', () => {
    const s = statsFromCounts({ approved: 1, edited: 0, rejected: 0, reversed: 0, badResult: 0, first: '2026-09-01T10:00:00Z', last: '2026-09-01T10:00:00Z' })
    expect(s.spanDays).toBe(0)
    expect(s.decisions).toBe(1)
  })
})

describe('validationStatus', () => {
  const ok = evaluatePromotion({ decisions: 30, cleanApprovals: 29, edited: 1, rejected: 0, badOutcomes: 0, spanDays: 20 }, DEFAULT_CRITERIA.message)
  const halfway = evaluatePromotion({ decisions: 14, cleanApprovals: 13, edited: 1, rejected: 0, badOutcomes: 0, spanDays: 20 }, DEFAULT_CRITERIA.message)
  const early = evaluatePromotion({ decisions: 2, cleanApprovals: 2, edited: 0, rejected: 0, badOutcomes: 0, spanDays: 1 }, DEFAULT_CRITERIA.message)

  it('só humano e automática vêm antes de qualquer conta', () => {
    expect(validationStatus({ level: 'approve', humanOnly: true, verdict: ok })).toBe('human_only')
    expect(validationStatus({ level: 'auto', humanOnly: false, verdict: early })).toBe('auto')
  })
  it('elegível quando o portão abriu; quase pronta a partir de 60% do caminho', () => {
    expect(ok.ready).toBe(true)
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: ok })).toBe('eligible')
    expect(halfway.progress).toBeGreaterThanOrEqual(0.6)
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: halfway })).toBe('almost')
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: early })).toBe('validating')
  })
  it('ação que só sugere não gera histórico: avisa em vez de "em validação"', () => {
    expect(validationStatus({ level: 'suggest', humanOnly: false, verdict: early })).toBe('suggest_only')
    // mas se o histórico já bastar, é elegível mesmo assim
    expect(validationStatus({ level: 'suggest', humanOnly: false, verdict: ok })).toBe('eligible')
  })
  it('uma reversão zera o progresso e nunca é "quase pronta"', () => {
    const bad = evaluatePromotion({ decisions: 19, cleanApprovals: 18, edited: 1, rejected: 0, badOutcomes: 1, spanDays: 13 }, DEFAULT_CRITERIA.message)
    expect(bad.progress).toBe(0)
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: bad })).toBe('validating')
  })
})

describe('promotedAt', () => {
  it('sanitiza datas válidas por ação e ignora lixo', () => {
    expect(sanitizePromotedAt({ send_followup: '2026-09-07T10:00:00.000Z', move_deal: 'ontem', xpto: '2026-09-07T10:00:00.000Z' })).toEqual({
      send_followup: '2026-09-07T10:00:00.000Z',
    })
    expect(sanitizePromotedAt(null)).toBeNull()
    expect(readPromotedAt({ promotedAt: { move_deal: '2026-09-01T00:00:00.000Z' } })).toEqual({ move_deal: '2026-09-01T00:00:00.000Z' })
    expect(readPromotedAt({})).toEqual({})
  })
  it('quem virou auto agora ganha a data; quem já era mantém; quem saiu perde', () => {
    const prev = { move_deal: '2026-09-01T00:00:00.000Z', send_followup: '2026-09-02T00:00:00.000Z' }
    const now = '2026-09-07T12:00:00.000Z'
    const out = nextPromotedAt({
      prev,
      wasAuto: (a) => a === 'move_deal' || a === 'send_followup' || a === 'notify_seller',
      isAuto: (a) => a === 'move_deal' || a === 'reactivation' || a === 'notify_seller',
      now,
    })
    expect(out).toEqual({ move_deal: '2026-09-01T00:00:00.000Z', reactivation: now, notify_seller: now })
  })
})

describe('gateApplies', () => {
  it('vale para o que nasce em sugere/aprova; não vale para o que já nasce automático nem para só-humano', () => {
    expect(gateApplies('send_followup')).toBe(true)
    expect(gateApplies('collect_charges')).toBe(true)
    expect(gateApplies('move_deal')).toBe(true)
    expect(gateApplies('reactivation')).toBe(true)
    expect(gateApplies('notify_seller')).toBe(false)
    expect(gateApplies('create_task')).toBe(false)
    expect(gateApplies('send_proposal')).toBe(false)
    expect(gateApplies('close_deal')).toBe(false)
  })
  it('ação sem portão fora do automático aparece como "liberada", não "em validação"', () => {
    const early = evaluatePromotion({ decisions: 0, cleanApprovals: 0, edited: 0, rejected: 0, badOutcomes: 0, spanDays: 0 }, DEFAULT_CRITERIA.notify)
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: early, gated: false })).toBe('free')
    expect(validationStatus({ level: 'auto', humanOnly: false, verdict: early, gated: false })).toBe('auto')
    expect(validationStatus({ level: 'approve', humanOnly: false, verdict: early, gated: true })).toBe('validating')
  })
})

describe('confidenceRate', () => {
  it('aprovadas sem edição ÷ decisões humanas; null sem amostra', () => {
    expect(confidenceRate({ approved: 9, edited: 1, rejected: 0 })).toBe(90)
    expect(confidenceRate({ approved: 0, edited: 0, rejected: 0 })).toBeNull()
  })
})

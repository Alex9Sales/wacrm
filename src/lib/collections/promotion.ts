// ============================================================
// 🧾 Fase 5 — soltar o automático, mas por EVIDÊNCIA.
//
// A ideia veio do retorno do ChatGPT (03/09) e os números foram recalibrados
// com o volume real: no ritmo do Rafael (5 follow-ups aprovados por semana),
// "50 decisões avaliadas" abriria o portão em ~10 semanas. Critério grande
// demais é o mesmo que não ter critério, porque o portão nunca abre e a
// decisão volta a ser sensação.
//
// Por isso o limiar é um PAR: quantidade mínima **e** janela de tempo mínima.
// E para cobrança ele é mais duro que para follow-up, porque o modo de falhar
// é pior: cobrar quem já pagou não tem desfazer.
//
// Parte PURA (client-safe). Quem lê o banco é promotion-data.ts.
// ============================================================

export interface PromotionCriteria {
  /** Decisões humanas avaliadas (aprovadas, editadas ou recusadas). */
  minDecisions: number
  /** Dias corridos desde a primeira decisão — evita 20 cliques numa tarde. */
  minDays: number
  /** Fração mínima aprovada SEM edição (o humano não precisou reescrever). */
  minCleanApprovalRate: number
  /** Fração máxima recusada. */
  maxRejectionRate: number
  /** Reversões e resultados ruins tolerados. Zero é zero. */
  maxBadOutcomes: number
}

/**
 * Cobrança fala de dinheiro com o cliente do nosso cliente. É mais duro que a
 * régua de follow-up de propósito, e `maxBadOutcomes: 0` é eliminatório —
 * não é estatística, é uma condição.
 */
export const COLLECTION_PROMOTION: PromotionCriteria = {
  minDecisions: 20,
  minDays: 14,
  minCleanApprovalRate: 0.9,
  maxRejectionRate: 0.05,
  maxBadOutcomes: 0,
}

export interface PromotionStats {
  /** Total de decisões humanas sobre a ação. */
  decisions: number
  /** Aprovadas sem o humano mexer no texto. */
  cleanApprovals: number
  /** Aprovadas depois de editar o texto (= a IA escreveu mal). */
  edited: number
  rejected: number
  /** Revertidas ou marcadas como resultado ruim (soma; inclui as críticas abaixo). */
  badOutcomes: number
  /**
   * Só as de RESULTADO RUIM: a ação aconteceu e não dava para desfazer (mensagem
   * errada entregue, cobrança de quem já pagou). Eliminatório sempre — desfazer
   * um card é recuperável, mandar a mensagem errada não. Ausente = 0.
   */
  criticalBadOutcomes?: number
  /** Dias entre a primeira e a última decisão. */
  spanDays: number
}

export type BlockerCode =
  | 'not_enough_decisions'
  | 'not_enough_time'
  | 'low_clean_approval'
  | 'too_many_rejections'
  | 'bad_outcomes'
  | 'critical_bad_result'

export interface PromotionVerdict {
  ready: boolean
  /** O que ainda falta, em português, para a tela mostrar sem traduzir nada. */
  blockers: { code: BlockerCode; label: string }[]
  /** 0..1 — o quanto do caminho já foi andado (o pior critério manda). */
  progress: number
  stats: PromotionStats
}

const pct = (n: number) => `${Math.round(n * 100)}%`

/**
 * Determinística e sem efeito colateral: dado o histórico, a ação pode subir de
 * "aprovação" para "automático"?
 */
export function evaluatePromotion(
  stats: PromotionStats,
  c: PromotionCriteria = COLLECTION_PROMOTION,
  opts: { noun?: string } = {},
): PromotionVerdict {
  const blockers: PromotionVerdict['blockers'] = []
  const ratios: number[] = []
  // "1 cobrança foi revertida" na régua; "1 ação foi revertida" no painel geral.
  const noun = opts.noun ?? 'ação'
  const nounPlural = noun.endsWith('ão') ? `${noun.slice(0, -2)}ões` : `${noun}s`

  if (stats.decisions < c.minDecisions) {
    blockers.push({
      code: 'not_enough_decisions',
      label: `Faltam ${c.minDecisions - stats.decisions} decisões (${stats.decisions} de ${c.minDecisions}).`,
    })
  }
  ratios.push(Math.min(1, stats.decisions / c.minDecisions))

  if (stats.spanDays < c.minDays) {
    blockers.push({
      code: 'not_enough_time',
      label: `Faltam ${c.minDays - stats.spanDays} dias de uso (${stats.spanDays} de ${c.minDays}).`,
    })
  }
  ratios.push(Math.min(1, stats.spanDays / c.minDays))

  // Taxas só fazem sentido com alguma amostra; sem decisão nenhuma, o que
  // bloqueia é a falta de histórico, não a qualidade dele.
  if (stats.decisions > 0) {
    const clean = stats.cleanApprovals / stats.decisions
    if (clean < c.minCleanApprovalRate) {
      blockers.push({
        code: 'low_clean_approval',
        label: `${pct(clean)} saíram sem você editar; o mínimo é ${pct(c.minCleanApprovalRate)}. Quando você reescreve, é a IA escrevendo mal.`,
      })
    }
    ratios.push(Math.min(1, clean / c.minCleanApprovalRate))

    const rej = stats.rejected / stats.decisions
    if (rej > c.maxRejectionRate) {
      blockers.push({
        code: 'too_many_rejections',
        label: `${pct(rej)} foram recusadas; o teto é ${pct(c.maxRejectionRate)}.`,
      })
    }
  }

  // Resultado ruim (irrecuperável) é eliminatório SEMPRE, independente da
  // tolerância configurada — mesmo com 98% de confiança. Desfeita (recuperável)
  // conta contra maxBadOutcomes.
  const critical = stats.criticalBadOutcomes ?? 0
  const reversals = Math.max(0, stats.badOutcomes - critical)
  if (critical > 0) {
    blockers.push({
      code: 'critical_bad_result',
      label:
        critical === 1
          ? `1 ${noun} teve resultado ruim (não dava para desfazer). Resultado ruim é eliminatório: precisa ser zero, mesmo com as outras taxas boas.`
          : `${critical} ${nounPlural} tiveram resultado ruim (não dava para desfazer). Resultado ruim é eliminatório: precisa ser zero, mesmo com as outras taxas boas.`,
    })
    ratios.push(0)
  }
  if (reversals > c.maxBadOutcomes) {
    const limite = c.maxBadOutcomes === 0 ? 'zero' : `no máximo ${c.maxBadOutcomes}`
    blockers.push({
      code: 'bad_outcomes',
      label:
        reversals === 1
          ? `1 ${noun} precisou ser desfeita. Para soltar o automático esse número precisa ser ${limite}.`
          : `${reversals} ${nounPlural} precisaram ser desfeitas. Para soltar o automático esse número precisa ser ${limite}.`,
    })
    // Um resultado ruim não é "quase lá": zera o progresso mostrado.
    ratios.push(0)
  }

  return {
    ready: blockers.length === 0,
    blockers,
    progress: ratios.length ? Math.min(...ratios) : 0,
    stats,
  }
}

/** Frase única para o topo da tela, sem o usuário abrir nada. */
export function promotionHeadline(v: PromotionVerdict): string {
  if (v.ready) {
    return 'A régua já tem histórico para operar sozinha. Você decide se libera.'
  }
  if (v.stats.decisions === 0) {
    return 'Ainda não há histórico: aprove ou recuse algumas cobranças e o Fluxia começa a medir.'
  }
  return v.blockers[0]?.label ?? 'Ainda reunindo histórico.'
}

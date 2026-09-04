import { describe, expect, it } from 'vitest'

import { ACTION_CATALOG, ORCH_ACTIONS } from './policy'
import { REVERT_MATRIX, contextFingerprint } from './revert'

describe('matriz de reversão', () => {
  it('toda ação do catálogo tem um plano — nenhuma fica sem resposta na auditoria', () => {
    for (const a of ORCH_ACTIONS) {
      expect(REVERT_MATRIX[a], a).toBeDefined()
      expect(REVERT_MATRIX[a].effect.length, a).toBeGreaterThan(20)
    }
    expect(Object.keys(REVERT_MATRIX).sort()).toEqual([...ORCH_ACTIONS].sort())
  })

  it('mensagem entregue NUNCA promete desfazer — vira correção', () => {
    expect(REVERT_MATRIX.send_followup.kind).toBe('correct')
    expect(REVERT_MATRIX.reactivation.kind).toBe('correct')
    expect(REVERT_MATRIX.send_followup.effect).toMatch(/não volta/i)
  })

  it('o que mexe em dinheiro/venda já comunicada escala, não desfaz em silêncio', () => {
    expect(REVERT_MATRIX.send_proposal.kind).toBe('escalate')
    expect(REVERT_MATRIX.close_deal.kind).toBe('escalate')
  })

  it('o que é estado interno do CRM volta de verdade', () => {
    for (const a of ['move_deal', 'create_task', 'update_follow_up', 'start_cadence', 'apply_discount', 'draft_proposal'] as const) {
      expect(REVERT_MATRIX[a].kind, a).toBe('undo')
    }
  })

  it('ação de aviso não inventa desfazer', () => {
    expect(REVERT_MATRIX.notify_seller.kind).toBe('note_only')
    expect(REVERT_MATRIX.notify_owner.kind).toBe('note_only')
  })

  it('nenhuma ação que só o humano executa promete undo automático', () => {
    for (const a of ORCH_ACTIONS) {
      if (ACTION_CATALOG[a].humanOnly) expect(REVERT_MATRIX[a].kind, a).not.toBe('undo')
    }
  })
})

describe('contextFingerprint', () => {
  it('agrupa decisões parecidas por ação + sinal + faixa de severidade', () => {
    expect(contextFingerprint('send_followup', 'proposal_idle', 85)).toBe('send_followup|proposal_idle|alta')
    expect(contextFingerprint('send_followup', 'proposal_idle', 82)).toBe('send_followup|proposal_idle|alta')
    expect(contextFingerprint('send_followup', 'proposal_idle', 60)).toBe('send_followup|proposal_idle|media')
    expect(contextFingerprint('send_followup', null, null)).toBe('send_followup|sem-sinal|na')
  })
})

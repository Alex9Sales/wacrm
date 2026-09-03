import { describe, expect, it } from 'vitest'

import { ACTION_CATALOG, DEFAULT_POLICY, decide, levelFor, readPolicy, type DecisionContext } from './policy'
import { recommend } from './nba'

const base: DecisionContext = {
  action: 'send_followup',
  policy: { ...DEFAULT_POLICY, levels: { send_followup: 'auto' } },
  accountPaused: false,
  withinHours: true,
  optedOut: false,
  humanActiveRecently: false,
  aiDisabledInConversation: false,
  usedToday: 0,
  messagesToday: 0,
  usedForDealToday: 0,
}

describe('readPolicy', () => {
  it('aceita o legado {reactivation:"auto", reactivationDailyCap}', () => {
    const p = readPolicy({ reactivation: 'auto', reactivationDailyCap: 15 })
    expect(levelFor(p, 'reactivation')).toBe('auto')
    expect(p.caps.reactivation).toBe(15)
  })
  it('lê o formato novo e ignora lixo', () => {
    const p = readPolicy({ actions: { send_followup: 'approve', move_deal: 'auto', xpto: 'auto' }, caps: { send_followup: 9999 }, discountAutoMaxPct: 8, paused: true })
    expect(levelFor(p, 'send_followup')).toBe('approve')
    expect(levelFor(p, 'move_deal')).toBe('auto')
    expect(p.caps.send_followup).toBe(500)
    expect(p.discountAutoMaxPct).toBe(8)
    expect(p.paused).toBe(true)
    // default do catálogo quando não configurado
    expect(levelFor(p, 'close_deal')).toBe('approve')
    expect(levelFor(p, 'create_task')).toBe('auto')
  })
})

describe('decide', () => {
  it('executa sozinho quando tudo está dentro', () => {
    expect(decide(base).decision).toBe('auto_execute')
  })
  it('kill switch da conta e do agente bloqueiam', () => {
    expect(decide({ ...base, accountPaused: true }).decision).toBe('blocked')
    expect(decide({ ...base, policy: { ...base.policy, paused: true } }).decision).toBe('blocked')
  })
  it('só sugerir quando o nível é suggest', () => {
    expect(decide({ ...base, policy: { ...DEFAULT_POLICY } }).decision).toBe('suggest_only')
  })
  it('nunca atropela humano: humano recente ou IA desligada → aprovação', () => {
    expect(decide({ ...base, humanActiveRecently: true }).decision).toBe('request_approval')
    expect(decide({ ...base, aiDisabledInConversation: true }).decision).toBe('request_approval')
  })
  it('crítico e só-humano nunca são automáticos', () => {
    expect(decide({ ...base, action: 'close_deal', policy: { ...DEFAULT_POLICY, levels: { close_deal: 'auto' } } }).decision).toBe('request_approval')
    expect(decide({ ...base, action: 'send_proposal', policy: { ...DEFAULT_POLICY, levels: { send_proposal: 'auto' } } }).decision).toBe('request_approval')
    expect(decide({ ...base, toolRisk: 'critical' }).decision).toBe('request_approval')
  })
  it('desconto: dentro do limite a IA aplica; acima pede aprovação', () => {
    const p = { ...DEFAULT_POLICY, levels: { apply_discount: 'auto' as const }, discountAutoMaxPct: 5 }
    expect(decide({ ...base, action: 'apply_discount', policy: p, discountPct: 3 }).decision).toBe('auto_execute')
    expect(decide({ ...base, action: 'apply_discount', policy: p, discountPct: 10 }).decision).toBe('request_approval')
    // e continua pedindo aprovação quando a política é 'approve' (o padrão)
    expect(decide({ ...base, action: 'apply_discount', policy: { ...DEFAULT_POLICY, levels: { apply_discount: 'approve' } }, discountPct: 1 }).decision).toBe('request_approval')
    expect(ACTION_CATALOG.apply_discount.humanOnly).toBeUndefined()
  })

  it('risco da FERRAMENTA externa sobrepõe o do catálogo (critical força aprovação)', () => {
    expect(decide({ ...base, toolRisk: 'critical' }).decision).toBe('request_approval')
    expect(decide({ ...base, toolRisk: 'low' }).decision).toBe('auto_execute')
  })
  it('fora do horário adia (mensagem) mas não bloqueia ação de CRM', () => {
    expect(decide({ ...base, withinHours: false }).decision).toBe('deferred')
    expect(decide({ ...base, action: 'create_task', withinHours: false }).decision).toBe('auto_execute')
  })
  it('tetos: por ação, por mensagens e por negócio', () => {
    expect(decide({ ...base, usedToday: 20 }).decision).toBe('blocked')
    expect(decide({ ...base, messagesToday: 30 }).decision).toBe('blocked')
    expect(decide({ ...base, usedForDealToday: 1 }).decision).toBe('blocked')
  })
  it('aviso tem teto padrão de 5/dia; mensagem 20', () => {
    expect(decide({ ...base, action: 'notify_seller', policy: { ...DEFAULT_POLICY }, usedToday: 5 }).decision).toBe('blocked')
    expect(decide({ ...base, action: 'notify_seller', policy: { ...DEFAULT_POLICY }, usedToday: 4 }).decision).toBe('auto_execute')
    expect(decide({ ...base, usedToday: 19 }).decision).toBe('auto_execute')
  })
  it('opt-out bloqueia mensagem, não bloqueia tarefa', () => {
    expect(decide({ ...base, optedOut: true }).decision).toBe('blocked')
    expect(decide({ ...base, action: 'create_task', optedOut: true }).decision).toBe('auto_execute')
  })
})

describe('NBA v1', () => {
  const ctx = { hasProposal: true, proposalAccepted: false, hasConversation: true, dealAssigned: true, contactName: 'Carlos Silva', dealTitle: 'Mentoria Premium' }
  it('proposta parada → follow-up', () => {
    const r = recommend({ signalType: 'proposal_idle', severity: 80, payload: { hours_idle: 80, viewed: true }, contactId: 'c', dealId: 'd' }, ctx)
    expect(r?.action).toBe('send_followup')
    expect(r?.reason).toMatch(/Carlos.*há 3 dias.*visualizou/)
  })
  it('quente sem proposta → proposta; quente com proposta → follow-up; aceita → nada', () => {
    const s = { signalType: 'high_intent', severity: 70, payload: {}, contactId: 'c', dealId: 'd' }
    expect(recommend(s, { ...ctx, hasProposal: false })?.action).toBe('send_proposal')
    expect(recommend(s, ctx)?.action).toBe('send_followup')
    expect(recommend(s, { ...ctx, proposalAccepted: true })).toBeNull()
  })
  it('parado sem conversa → avisa vendedor (ou dono se sem dono)', () => {
    const s = { signalType: 'stale_deal', severity: 60, payload: { days_stale: 9 }, contactId: 'c', dealId: 'd' }
    expect(recommend(s, { ...ctx, hasConversation: false })?.action).toBe('notify_seller')
    expect(recommend(s, { ...ctx, hasConversation: false, dealAssigned: false })?.action).toBe('notify_owner')
    expect(recommend(s, ctx)?.action).toBe('send_followup')
  })
  it('parado há mais de 60 dias é backlog morto → nada', () => {
    expect(recommend({ signalType: 'stale_deal', severity: 80, payload: { days_stale: 120 }, contactId: 'c', dealId: 'd' }, ctx)).toBeNull()
  })
  it('churn NÃO vira ação aqui (motor de recompra é o dono); ticket caindo → avisa; tipo desconhecido → null', () => {
    expect(recommend({ signalType: 'churn_risk', severity: 75, payload: { days_since: 40, avg_days: 15 }, contactId: 'c', dealId: null }, ctx)).toBeNull()
    expect(recommend({ signalType: 'ticket_declining', severity: 55, payload: { last_amount: 80, avg_ticket: 150 }, contactId: 'c', dealId: null }, ctx)?.action).toBe('notify_seller')
    expect(recommend({ signalType: 'xpto', severity: 1, payload: {}, contactId: 'c', dealId: null }, ctx)).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { parseCloseDirectives } from './defaults'
import { crossFunnelInstruction } from './funnel-target'

// Zelo 18/09 (Jordan): reunião marcada = ganho no pré-vendas + card novo no
// comercial; lead de outra campanha = perdido com motivo + card novo no funil
// certo; transferência com resumo pra quem assume.
describe('parseCloseDirectives — [[GANHO]] e [[RESUMO:…]]', () => {
  it('reads a win together with the next funnel and strips both from the text', () => {
    const d = parseCloseDirectives(
      'Combinado, até terça! [[GANHO]]\n[[FUNIL:2. Comercial | Franquia > Reunião agendada]]',
    )
    expect(d.win).toBe(true)
    expect(d.funnelStage).toBe('2. Comercial | Franquia > Reunião agendada')
    expect(d.text).toBe('Combinado, até terça!')
  })

  it('reads a loss with reason plus the right funnel', () => {
    const d = parseCloseDirectives(
      'Vou te passar pra equipe. [[PERDER:Lead interessado em serviço]] [[FUNIL:3. Comercial | Serviços > Novo lead]]',
    )
    expect(d.lose).toEqual({ reason: 'Lead interessado em serviço' })
    expect(d.funnelStage).toBe('3. Comercial | Serviços > Novo lead')
    expect(d.win).toBe(false)
  })

  it('captures the handoff summary even with brackets inside and never leaks it', () => {
    const d = parseCloseDirectives(
      'Já vou passar pro responsável. [[RESUMO:Orçamento limpeza [residencial], bairro X, 1x/mês]]',
    )
    expect(d.handoffSummary).toBe('Orçamento limpeza [residencial], bairro X, 1x/mês')
    expect(d.text).toBe('Já vou passar pro responsável.')
  })

  it('no markers → no win, no summary', () => {
    const d = parseCloseDirectives('Oi! Tudo bem?')
    expect(d.win).toBe(false)
    expect(d.handoffSummary).toBeNull()
  })
})

describe('crossFunnelInstruction', () => {
  it('teaches the close-and-open combinations', () => {
    const t = crossFunnelInstruction([{ name: '4. Individual', stages: ['Novo lead'] }])
    expect(t).toContain('[[GANHO]]')
    expect(t).toContain('[[PERDER:<reason>]]')
  })
})

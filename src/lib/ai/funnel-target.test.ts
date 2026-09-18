import { describe, it, expect } from 'vitest'
import { resolveFunnelTarget, splitCrossFunnel, crossFunnelInstruction, type FunnelOption } from './funnel-target'

// Funis como os da Zelo (nomes com "|" e numeração).
const FUNNELS: FunnelOption[] = [
  { id: 'p1', name: '1. Cadência pré-vendas', stages: [{ id: 's11', name: 'Sem contato' }, { id: 's12', name: 'Definição' }] },
  { id: 'p2', name: '2. Comercial | Franquia', stages: [{ id: 's21', name: 'Novo lead' }, { id: 's22', name: 'Qualificação' }] },
  { id: 'p3', name: '3. Comercial | Serviços', stages: [{ id: 's31', name: 'Novo lead' }, { id: 's32', name: 'Contato atendimento' }] },
  { id: 'p6', name: '6. Recrutamento', stages: [] },
]

describe('splitCrossFunnel', () => {
  it('splits on the last ">"', () => {
    expect(splitCrossFunnel('3. Comercial | Serviços > Novo lead')).toEqual({ funnel: '3. Comercial | Serviços', stage: 'Novo lead' })
    expect(splitCrossFunnel('Serviços >')).toEqual({ funnel: 'Serviços', stage: null })
  })
  it('no ">" is a plain stage move, not cross-funnel', () => {
    expect(splitCrossFunnel('Qualificado')).toBeNull()
    expect(splitCrossFunnel('> Novo lead')).toBeNull()
  })
})

describe('resolveFunnelTarget', () => {
  it('exact funnel and stage, ignoring accents and case', () => {
    expect(resolveFunnelTarget(FUNNELS, '3. comercial | servicos > contato atendimento')).toEqual({
      pipelineId: 'p3', pipelineName: '3. Comercial | Serviços', stageId: 's32', stageName: 'Contato atendimento',
    })
  })
  it('unique partial funnel name works; unknown stage falls back to the first stage', () => {
    expect(resolveFunnelTarget(FUNNELS, 'Serviços > Etapa inventada')?.stageId).toBe('s31')
  })
  it('ambiguous partial funnel name does NOT move', () => {
    expect(resolveFunnelTarget(FUNNELS, 'Comercial > Novo lead')).toBeNull()
  })
  it('unknown funnel, funnel without stages, or no ">" → null', () => {
    expect(resolveFunnelTarget(FUNNELS, 'Pós-venda > Onboarding')).toBeNull()
    expect(resolveFunnelTarget(FUNNELS, '6. Recrutamento > Novo')).toBeNull()
    expect(resolveFunnelTarget(FUNNELS, 'Novo lead')).toBeNull()
  })
})

describe('crossFunnelInstruction', () => {
  it('lists funnels with their stages and the marker format', () => {
    const t = crossFunnelInstruction([{ name: '3. Comercial | Serviços', stages: ['Novo lead', 'Contato atendimento'] }])
    expect(t).toContain('"3. Comercial | Serviços" (Novo lead → Contato atendimento)')
    expect(t).toContain('[[FUNIL:<funnel name> > <stage name>]]')
  })
})

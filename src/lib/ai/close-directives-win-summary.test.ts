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

// 02/10/2026 (conta com agente OpenAI): o modelo fechou o resumo com "] ]" — o
// regex não casou, a nota saiu sem o resumo e o marcador foi pro cliente.
describe('[[RESUMO:…]] mal fechado (02/10/2026)', () => {
  const resumo = (raw: string) => parseCloseDirectives(raw)

  it('o caso real: fechado com "] ]" → resumo extraído e nada sobra pro cliente', () => {
    const d = resumo('[[RESUMO:Cliente quer adquirir o kit; esclarecer todas as medidas.] ]')
    expect(d.handoffSummary).toBe('Cliente quer adquirir o kit; esclarecer todas as medidas.')
    expect(d.text).toBe('')
  })

  it('"]]", "] ]" e "]\\n]" dão o mesmo resumo', () => {
    for (const fecho of [']]', '] ]', ']\n]', ']  ]']) {
      const d = resumo(`Já te passo pro responsável.\n[[RESUMO:Ana, bairro Centro, 2x/mês${fecho}`)
      expect(d.handoffSummary).toBe('Ana, bairro Centro, 2x/mês')
      expect(d.text).toBe('Já te passo pro responsável.')
    }
  })

  it('sem fechamento vale até o fim do texto (e "]" solto no fim também fecha)', () => {
    expect(resumo('[[RESUMO:Ana quer orçamento\nmora no Centro').handoffSummary).toBe(
      'Ana quer orçamento\nmora no Centro',
    )
    const d = resumo('Já chamo alguém.\n[[RESUMO:Ana quer orçamento]')
    expect(d.handoffSummary).toBe('Ana quer orçamento')
    expect(d.text).toBe('Já chamo alguém.')
  })

  it('minúsculas e espaços dentro do marcador', () => {
    expect(resumo('[[ resumo :  Ana, Centro  ] ]').handoffSummary).toBe('Ana, Centro')
  })

  it('o resumo NÃO engole o texto depois de um fechamento válido', () => {
    const d = resumo('[[RESUMO:Ana, Centro]] Obrigada pelo contato ]]')
    expect(d.handoffSummary).toBe('Ana, Centro')
    expect(d.text).toBe('Obrigada pelo contato ]]')
  })

  it('sem fechamento, para antes do próximo marcador (que continua valendo)', () => {
    const d = resumo('[[RESUMO:Ana quer orçamento\n[[GANHO]]')
    expect(d.handoffSummary).toBe('Ana quer orçamento')
    expect(d.win).toBe(true)
    expect(d.text).toBe('')
  })

  it('"]" do próprio resumo antes do fechamento continua no resumo', () => {
    expect(resumo('[[RESUMO:Ana [Centro]]]').handoffSummary).toBe('Ana [Centro]')
    expect(resumo('[[RESUMO:Ana [Centro] ]]').handoffSummary).toBe('Ana [Centro]')
  })

  it('resumo vazio não vira resumo', () => {
    expect(resumo('[[RESUMO:]]').handoffSummary).toBeNull()
    expect(resumo('[[RESUMO: ] ]').handoffSummary).toBeNull()
  })
})

describe('crossFunnelInstruction', () => {
  it('teaches the close-and-open combinations', () => {
    const t = crossFunnelInstruction([{ name: '4. Individual', stages: ['Novo lead'] }])
    expect(t).toContain('[[GANHO]]')
    expect(t).toContain('[[PERDER:<reason>]]')
  })
})

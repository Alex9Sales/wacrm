import { describe, expect, it } from 'vitest'

import { normalizeAgentSwitches } from './switches'

// 25/09: a tela prendia a auto-resposta ligada quando o assistente era
// desligado, e gravava assim. A IA parava de verdade, mas a tela dizia que
// não — e "parece que está ligada" custa a confiança do cliente do mesmo
// jeito que estar ligada de verdade.

describe('as duas chaves do agente', () => {
  it('assistente desligado derruba a auto-resposta junto', () => {
    expect(
      normalizeAgentSwitches({ isActive: false, autoReplyEnabled: true }),
    ).toEqual({ isActive: false, autoReplyEnabled: false })
  })

  it('com o assistente ligado, a auto-resposta é escolha de quem configura', () => {
    expect(
      normalizeAgentSwitches({ isActive: true, autoReplyEnabled: true }),
    ).toEqual({ isActive: true, autoReplyEnabled: true })
    expect(
      normalizeAgentSwitches({ isActive: true, autoReplyEnabled: false }),
    ).toEqual({ isActive: true, autoReplyEnabled: false })
  })

  it('desligado dos dois lados continua desligado', () => {
    expect(
      normalizeAgentSwitches({ isActive: false, autoReplyEnabled: false }),
    ).toEqual({ isActive: false, autoReplyEnabled: false })
  })

  it('religar o assistente não solta a IA nos clientes sozinha', () => {
    // O caminho que o cliente percorre: desliga tudo, pensa melhor, religa só
    // o assistente para usar o rascunho. A auto-resposta NÃO pode voltar junto.
    const desligou = normalizeAgentSwitches({ isActive: false, autoReplyEnabled: true })
    const religou = normalizeAgentSwitches({ ...desligou, isActive: true })
    expect(religou.autoReplyEnabled).toBe(false)
  })
})

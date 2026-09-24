import { describe, expect, it } from 'vitest'

import { skipInstruction } from './defaults'

// 24/09 (caso Rosangela, Família do Gás): a Maria perguntou "Fecho assim,
// Rosangela? 😊 Ultragaz R$ 125,00 no débito, no mesmo endereço da última vez.
// Confirmando, já mando o entregador." às 18:17:06. A cliente respondeu
// "Obrigada" às 18:17:28 — e a IA CALOU, porque "obrigado" está na lista de
// exemplos do que se pode ignorar. O pedido nunca foi criado, o card nunca
// nasceu, e às 19:32 a cliente perguntou "Seu entregador já saiu?" esperando
// uma entrega que ninguém tinha chamado.

describe('instrução de ignorar — o silêncio que custou a venda da Rosangela', () => {
  const texto = skipInstruction()

  it('continua permitindo ignorar o que é só ruído', () => {
    expect(texto).toContain('[[IGNORAR]]')
    expect(texto).toContain('thumbs-up')
  })

  it('proíbe ignorar quando a PRÓPRIA IA perguntou algo', () => {
    expect(texto).toContain('NEVER skip')
    expect(texto.toLowerCase()).toContain('asked a question')
  })

  it('diz que ali o agradecimento é um SIM, não um encerramento', () => {
    expect(texto).toContain('means YES')
    // Os agradecimentos e confirmações curtas que aparecem na vida real.
    for (const palavra of ['obrigado', 'ok', 'tá bom', 'isso', 'pode']) {
      expect(texto).toContain(palavra)
    }
  })

  it('manda EXECUTAR o que estava pendente, não só responder', () => {
    expect(texto).toContain('pending action')
    expect(texto).toContain('create the order')
  })

  it('mantém a regra de ouro: na dúvida, responde', () => {
    expect(texto).toContain('When in doubt, reply normally')
  })
})

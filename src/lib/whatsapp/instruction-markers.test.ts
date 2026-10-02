import { describe, expect, it } from 'vitest'
import { stripInstructionMarkers } from './instruction-markers'

/**
 * Esta função é a última porta antes do cliente. O que precisa de teste não é
 * a regex — é que ela NÃO deixe passar marcador nenhum (nem o que ainda não
 * existe) e que NÃO coma o que é conteúdo de verdade.
 */
describe('o caso real: a Aline recebeu o marcador cru (Zelo, 29/09)', () => {
  const texto =
    'Estou enviando a Circular de Oferta de Franquia, o documento oficial com ' +
    'investimento, estrutura e o modelo do negócio. Você terá 10 dias para ' +
    'analisar tudo com calma. [[ENVIAR: Circular de Oferta de Franquia]]'

  it('tira o marcador e deixa a frase inteira', () => {
    const r = stripInstructionMarkers(texto)
    expect(r.text).toBe(
      'Estou enviando a Circular de Oferta de Franquia, o documento oficial com ' +
        'investimento, estrutura e o modelo do negócio. Você terá 10 dias para ' +
        'analisar tudo com calma.',
    )
    expect(r.text).not.toContain('[[')
  })

  it('diz o que removeu — o material que não foi precisa de rastro', () => {
    expect(stripInstructionMarkers(texto).removed).toEqual([
      '[[ENVIAR: Circular de Oferta de Franquia]]',
    ])
  })
})

describe('não deixa passar marcador nenhum', () => {
  it('pega os que já existem no sistema', () => {
    for (const m of [
      '[[FUNIL:Vendas > Proposta]]',
      '[[PERDER:sem interesse]]',
      '[[COBRANCA:pix]]',
      '[[FERRAMENTA:consultar_pedido]]',
      '[[ENVIAR:contrato]]',
    ]) {
      expect(stripInstructionMarkers(`Oi. ${m}`).text).toBe('Oi.')
    }
  })

  it('pega o marcador que ainda não foi inventado', () => {
    // A regra é "tudo é interno menos o que se conhece": marcador novo que
    // alguém puser no prompt amanhã já nasce bloqueado.
    expect(stripInstructionMarkers('Pronto. [[QUALQUER_COISA:x]]').text).toBe('Pronto.')
  })

  it('pega vários de uma vez, inclusive em linha própria', () => {
    const r = stripInstructionMarkers('Segue.\n[[ENVIAR:a]]\n[[ENVIAR:b]]\nAbraço.')
    expect(r.text).toBe('Segue.\nAbraço.')
    expect(r.removed).toHaveLength(2)
  })

  it('um texto que é SÓ marcador não vira lixo, vira vazio', () => {
    expect(stripInstructionMarkers('[[ENVIAR:contrato]]').text).toBe('')
  })
})

describe('não come o que é conteúdo de verdade', () => {
  it('deixa [[AUDIO]] e [[foto:…]] passarem — são pedidos reais', () => {
    expect(stripInstructionMarkers('Bom dia [[AUDIO]]').text).toBe('Bom dia [[AUDIO]]')
    expect(stripInstructionMarkers('Olha [[foto:frente]]').text).toBe('Olha [[foto:frente]]')
  })

  it('colchete simples é texto comum, não marcador', () => {
    const t = 'O valor [conforme tabela] é R$ 130.'
    expect(stripInstructionMarkers(t).text).toBe(t)
  })

  it('texto sem marcador volta idêntico, sem re-formatação', () => {
    const t = 'Linha 1\n\nLinha 2   com   espaços'
    expect(stripInstructionMarkers(t).text).toBe(t)
    expect(stripInstructionMarkers(t).removed).toEqual([])
  })

  it('null e vazio passam sem quebrar', () => {
    expect(stripInstructionMarkers(null).text).toBeNull()
    expect(stripInstructionMarkers(undefined).text).toBeNull()
    expect(stripInstructionMarkers('').text).toBe('')
  })
})

describe('duas chamadas seguidas limpam as duas', () => {
  it('o lastIndex de uma não atrapalha a próxima', () => {
    // Regex global guarda posição. Reaproveitar uma instância entre chamadas
    // faria a segunda mensagem começar a busca no meio — e vazar.
    const a = stripInstructionMarkers('Um [[ENVIAR:x]]')
    const b = stripInstructionMarkers('Dois [[ENVIAR:y]]')
    expect(a.text).toBe('Um')
    expect(b.text).toBe('Dois')
  })
})

// 02/10/2026 (conta com agente OpenAI): numa transferência o modelo fechou o
// resumo para a equipe com "] ]" e ele foi ENVIADO como despedida, com os
// dados do cliente. A rede só reconhecia "[[…]]" fechado, e linha a linha.
describe('marcador conhecido MAL FECHADO (02/10/2026)', () => {
  it('o caso real: "[[RESUMO:… ] ]" some inteiro', () => {
    const r = stripInstructionMarkers('[[RESUMO:Cliente quer adquirir o kit; esclarecer todas as medidas.] ]')
    expect(r.text).toBe('')
    expect(r.removed).toEqual(['[[RESUMO:Cliente quer adquirir o kit; esclarecer todas as medidas.] ]'])
  })

  it('"]\\n]", sem fechar ou com "]" só: some até o fechamento ou o fim do texto', () => {
    expect(stripInstructionMarkers('Já te passo.\n[[RESUMO:Ana, Centro]\n]').text).toBe('Já te passo.')
    expect(stripInstructionMarkers('Já te passo.\n[[RESUMO:Ana, Centro').text).toBe('Já te passo.')
    expect(stripInstructionMarkers('Já te passo. [[TRANSFERIR:Vendas|Ana]').text).toBe('Já te passo.')
  })

  it('atravessa linhas: o resumo em várias linhas sai inteiro e o texto em volta fica', () => {
    const r = stripInstructionMarkers('Perfeito!\n[[RESUMO:Ana\ncidade Centro\norçamento] ]\nAté já.')
    expect(r.text).toBe('Perfeito!\nAté já.')
    expect(r.removed).toHaveLength(1)
  })

  it('o fechado em várias linhas também sai (antes, linha a linha, vazava)', () => {
    expect(stripInstructionMarkers('Oi.\n[[NOTA:linha 1\nlinha 2]]\nTchau.').text).toBe('Oi.\nTchau.')
  })

  it('para no fechamento: o texto depois dele fica', () => {
    expect(stripInstructionMarkers('[[RESUMO:Ana] ] Qualquer coisa me chama.').text).toBe('Qualquer coisa me chama.')
  })

  it('sem fechamento, para antes do próximo "[[" — o [[foto:…]] seguinte não é comido', () => {
    expect(stripInstructionMarkers('[[RESUMO:Ana\n[[foto:frente]]').text).toBe('[[foto:frente]]')
  })

  it('marcador sem argumento fecha no 1º "]" — a frase depois fica', () => {
    expect(stripInstructionMarkers('[[GANHO] Obrigada!').text).toBe('Obrigada!')
    expect(stripInstructionMarkers('Combinado. [[HANDOFF] ]').text).toBe('Combinado.')
  })

  it('minúsculas, espaços e cedilha', () => {
    expect(stripInstructionMarkers('Oi [[ resumo : Ana ] ]').text).toBe('Oi')
    expect(stripInstructionMarkers('Oi [[COBRANÇA:promessa] ]').text).toBe('Oi')
  })

  it('"[[" sem nome conhecido não é mexido (texto comum)', () => {
    const t = 'Use [[ colchetes duplos ] ] assim, ou [[QUALQUER] ] coisa'
    expect(stripInstructionMarkers(t).text).toBe(t)
    expect(stripInstructionMarkers(t).removed).toEqual([])
  })

  it('nome que só COMEÇA igual não é o marcador ("[[NOTAS" não é NOTA)', () => {
    const t = 'Veja as [[NOTAS] ] da reunião'
    expect(stripInstructionMarkers(t).text).toBe(t)
  })

  it('[[AUDIO]] e [[foto:…]] continuam passando', () => {
    expect(stripInstructionMarkers('[[AUDIO]] Bom dia [[RESUMO:x] ]').text).toBe('[[AUDIO]] Bom dia')
  })
})

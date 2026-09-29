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

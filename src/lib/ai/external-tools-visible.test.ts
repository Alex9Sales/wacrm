import { describe, it, expect } from 'vitest'
import { needsReplyRetry, parseToolCall, visibleReplyText } from './external-tools'

describe('visibleReplyText', () => {
  it('resposta só com marcadores é VAZIA pro cliente (caso Família do Gás 18/09)', () => {
    expect(visibleReplyText('[[CRIARCARD]]')).toBe('')
    expect(visibleReplyText('[[CRIARCARD]]\n[[ETIQUETA:pedido]]\n[[NOTA:cliente pediu troco pra 200]]')).toBe('')
  })

  it('texto com marcadores mantém só o texto', () => {
    expect(visibleReplyText('Pedido confirmado! 😊 [[CRIARCARD]]')).toBe('Pedido confirmado! 😊')
  })

  it('nulo ou em branco é vazio', () => {
    expect(visibleReplyText(null)).toBe('')
    expect(visibleReplyText('   ')).toBe('')
  })
})

describe('parseToolCall — ferramenta sem parâmetro', () => {
  it('"[[FERRAMENTA: consultar_estoque]]" sem o "| {}" também é chamada', () => {
    expect(parseToolCall('[[FERRAMENTA: consultar_estoque]]')).toEqual({
      slug: 'consultar_estoque',
      args: {},
      marker: '[[FERRAMENTA: consultar_estoque]]',
    })
    expect(parseToolCall('[[FERRAMENTA: buscar_cliente | {"telefone": "67990001234"}]]')?.args).toEqual({ telefone: '67990001234' })
  })
})

describe('needsReplyRetry', () => {
  it('depois de escrita sem texto: sempre tenta de novo', () => {
    expect(needsReplyRetry({ text: '[[CRIARCARD]]', writeSucceeded: true, toolsRan: 1 })).toBe(true)
  })

  it('depois de só consultas e resposta vazia: tenta de novo (caso 19/09)', () => {
    expect(needsReplyRetry({ text: '', writeSucceeded: false, toolsRan: 2 })).toBe(true)
  })

  it('silêncio escolhido ([[IGNORAR]]/transferência) ou sem ferramenta: não força', () => {
    expect(needsReplyRetry({ text: '[[IGNORAR]]', writeSucceeded: false, toolsRan: 2 })).toBe(false)
    expect(needsReplyRetry({ text: '[[TRANSFERIR:Responsável|resumo]]', writeSucceeded: false, toolsRan: 1 })).toBe(false)
    expect(needsReplyRetry({ text: '', writeSucceeded: false, toolsRan: 0 })).toBe(false)
  })

  it('com texto pro cliente: nada a fazer', () => {
    expect(needsReplyRetry({ text: 'Bom dia! 😊', writeSucceeded: true, toolsRan: 3 })).toBe(false)
  })
})

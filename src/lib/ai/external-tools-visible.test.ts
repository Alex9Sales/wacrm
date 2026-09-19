import { describe, it, expect } from 'vitest'
import { visibleReplyText } from './external-tools'

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

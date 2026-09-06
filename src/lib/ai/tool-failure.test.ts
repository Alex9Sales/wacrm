import { describe, expect, it } from 'vitest'

import { failureKey, retryBlockedSummary, withFailureGuidance } from './tool-failure'

describe('ferramenta que falhou — o modelo lê o que fazer, não só que falhou', () => {
  it('a falha vem com as regras: não transferir, não repetir, seguir com o que sabe', () => {
    const t = withFailureGuidance('buscar_cliente', 'Falha na chamada: This operation was aborted')
    expect(t).toContain('This operation was aborted')
    expect(t).toContain('NÃO é motivo para transferir')
    expect(t).toContain('NÃO chame buscar_cliente de novo')
    expect(t).toContain('tabela de preços')
    expect(t).toContain('Nunca conte ao cliente')
  })

  it('a segunda tentativa da mesma chamada é bloqueada com instrução clara', () => {
    expect(retryBlockedSummary('consultar_estoque')).toContain('Já tentei consultar_estoque')
    expect(retryBlockedSummary('consultar_estoque')).toContain('NÃO é opção')
  })

  it('a chave distingue argumentos diferentes da mesma ferramenta', () => {
    expect(failureKey('buscar_cliente', 'a')).not.toBe(failureKey('buscar_cliente', 'b'))
    expect(failureKey('buscar_cliente', 'a')).toBe(failureKey('buscar_cliente', 'a'))
  })
})

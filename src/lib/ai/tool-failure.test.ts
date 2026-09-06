import { describe, expect, it } from 'vitest'

import { failureKey, fallbackKindFor, formatCrmFallback, retryBlockedSummary, withFailureGuidance } from './tool-failure'

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

describe('fonte alternativa — o CRM responde quando o ERP não responde', () => {
  it('ferramenta de cliente → histórico do CRM vira cadastro válido, sem inventar endereço', () => {
    const t = formatCrmFallback({ kind: 'customer', contactName: 'Miriam', facts: 'Cliente recorrente: 3 compras no histórico.\nProduto mais comprado: P-13 UltraGaz.' })
    expect(t).toContain('HISTÓRICO DO CRM')
    expect(t).toContain('Cliente: Miriam.')
    expect(t).toContain('3 compras')
    expect(t).toContain('NÃO passa pelo teste de distância')
    expect(t).toContain('NÃO tem o endereço')
  })

  it('sem histórico no CRM → cliente novo, sem transferir', () => {
    const t = formatCrmFallback({ kind: 'customer', contactName: null, facts: null })
    expect(t).toContain('cliente novo')
    expect(t).not.toContain('transfira')
  })

  it('estoque/distância → segue com a tabela; escrita → não confirma e avisa a equipe', () => {
    expect(formatCrmFallback({ kind: 'generic', contactName: 'Ana', facts: null })).toContain('tabela de preços')
    expect(formatCrmFallback({ kind: 'write', contactName: 'Ana', facts: null })).toContain('NÃO FOI FEITA')
  })

  it('o tipo vem do slug e do risco', () => {
    expect(fallbackKindFor('buscar_cliente', 'read')).toBe('customer')
    expect(fallbackKindFor('historico_compras', 'read')).toBe('customer')
    expect(fallbackKindFor('consultar_estoque', 'read')).toBe('generic')
    expect(fallbackKindFor('criar_pedido', 'write')).toBe('write')
  })
})

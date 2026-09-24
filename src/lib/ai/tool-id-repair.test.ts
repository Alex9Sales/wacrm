import { describe, expect, it } from 'vitest'

import { closestKnownId, idsInText, looksLikeId, repairIdArgs } from './tool-id-repair'

// 24/09 (Família do Gás): a Maria copia o código do produto do consultar_estoque
// pro criar_pedido e erra dígitos. Em 7 dias, 102 pedidos com o código certo e
// 8 perdidos — o ERP devolve "Produto nao encontrado" com o cliente já tendo
// dito "pode". Todos os valores abaixo são os que ela realmente mandou.

const ULTRAGAZ = 'e69c3897-7618-4dac-ac8a-5b04f35d423a'
const COPAGAZ = '7229662d-d5b1-4935-838b-ac58df0672da'
const AGUA = '693b240e-b633-41db-bf2a-f7de1b02dee0'
const ESTOQUE = [ULTRAGAZ, COPAGAZ, AGUA]

describe('os erros reais de transcrição viram o código certo', () => {
  it.each([
    ['e69c3897-7618-4dac-ac8a-5b04a1c6815a', 'caso Nicole, 24/09'],
    ['e69c3897-7618-4dac-ac8a-5b04c0a1c6815a', 'um caractere a mais, 4 vezes'],
    ['e69c3897-7618-4dac-ac89-5b04f35d423a', 'ac8a virou ac89'],
    ['e69c3897-7618-4dac-ac58-5b04f35d423a', 'ac8a virou ac58'],
  ])('%s (%s)', (errado) => {
    expect(closestKnownId(errado, ESTOQUE)).toBe(ULTRAGAZ)
  })

  it('o código certo não é "corrigido" — não há o que consertar', () => {
    expect(closestKnownId(ULTRAGAZ, ESTOQUE)).toBeNull()
    expect(closestKnownId(COPAGAZ, ESTOQUE)).toBeNull()
  })

  it('código de outro produto conhecido passa intacto (não vira Ultragaz)', () => {
    expect(closestKnownId(AGUA, ESTOQUE)).toBeNull()
  })

  it('código sem nada parecido fica como está — melhor o erro do ERP que o produto errado', () => {
    expect(closestKnownId('11111111-2222-3333-4444-555555555555', ESTOQUE)).toBeNull()
    expect(closestKnownId('e69c3897-0000-0000-0000-000000000000', ESTOQUE)).toBeNull()
  })

  it('dois candidatos parecidos = ambiguidade: não chuta', () => {
    const gemeo = 'e69c3897-7618-4dac-ac8a-5b04ffffffff'
    expect(closestKnownId('e69c3897-7618-4dac-ac8a-5b04a1c6815a', [ULTRAGAZ, gemeo])).toBeNull()
  })

  it('sem nada conhecido, não inventa', () => {
    expect(closestKnownId(ULTRAGAZ, [])).toBeNull()
  })
})

describe('looksLikeId — o que é código e o que é dado do cliente', () => {
  it('reconhece o código do produto', () => {
    expect(looksLikeId(ULTRAGAZ)).toBe(true)
  })

  it('telefone, valor, endereço e nome NÃO são código', () => {
    expect(looksLikeId('67998026746')).toBe(false)
    expect(looksLikeId('125,00')).toBe(false)
    expect(looksLikeId('Rua Acropole 1644')).toBe(false)
    expect(looksLikeId('Nicole')).toBe(false)
    expect(looksLikeId('')).toBe(false)
    expect(looksLikeId(125)).toBe(false)
    expect(looksLikeId(null)).toBe(false)
  })
})

describe('idsInText — os códigos que a ferramenta respondeu', () => {
  it('tira os ids do JSON do consultar_estoque', () => {
    const resposta = `[{"id":"${AGUA}","name":"Água Mineral 20L"}, {"id":"${COPAGAZ}","name":"P-13 Copagaz"}]`
    expect(idsInText(resposta)).toEqual([AGUA, COPAGAZ])
  })

  it('texto sem código nenhum, ou vazio, devolve lista vazia', () => {
    expect(idsInText('Pedido criado com sucesso')).toEqual([])
    expect(idsInText(null)).toEqual([])
  })
})

describe('repairIdArgs — o pedido da Nicole que se perdeu', () => {
  const pedido = {
    nome: 'Nicole',
    telefone: '67998026746',
    endereco: 'Rua Acropole 1644',
    bairro: 'Bosque da Esperança',
    pagamento: 'pix',
    quantidade: 1,
    produto_id: 'e69c3897-7618-4dac-ac8a-5b04a1c6815a',
  }

  it('corrige só o código e não encosta no resto do pedido', () => {
    const r = repairIdArgs(pedido, ESTOQUE)
    expect(r.args.produto_id).toBe(ULTRAGAZ)
    expect(r.args.telefone).toBe('67998026746')
    expect(r.args.endereco).toBe('Rua Acropole 1644')
    expect(r.repairs).toEqual([
      { param: 'produto_id', from: 'e69c3897-7618-4dac-ac8a-5b04a1c6815a', to: ULTRAGAZ },
    ])
  })

  it('pedido já correto sai igualzinho — e é o MESMO objeto, sem cópia à toa', () => {
    const ok = { ...pedido, produto_id: ULTRAGAZ }
    const r = repairIdArgs(ok, ESTOQUE)
    expect(r.args).toBe(ok)
    expect(r.repairs).toHaveLength(0)
  })

  it('sem códigos conhecidos, devolve o que veio', () => {
    const r = repairIdArgs(pedido, [])
    expect(r.args).toBe(pedido)
    expect(r.repairs).toHaveLength(0)
  })
})

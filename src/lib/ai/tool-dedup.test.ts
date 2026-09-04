import { describe, expect, it } from 'vitest'

import { stableArgsKey } from './external-tools'

/**
 * Os TRÊS `criar_pedido` reais do Wellington (Família do Gás, 04/09), copiados
 * de `agent_tool_runs`. Um botijão, três pedidos — o Alex apagou dois na mão.
 */
const cartao = {
  nome: 'Wellington',
  bairro: 'Mata do Jacinto',
  endereco: 'Rua Jorge Kalil Duailibi, 10',
  telefone: '67993204562',
  pagamento: 'credito_avista',
  produto_id: 'e69c3897-7618-4dac-ac8a-5b04f35d423a',
  quantidade: 1,
  referencia: '',
  obs_entrega: '',
  valor_unitario: 125,
}

const pix = {
  ...cartao,
  pagamento: 'pix',
  obs_entrega: 'Pagamento via Pix na entrega. Há um cachorro no local; chamar pelo telefone ao chegar.',
}

const pixComprovante = {
  ...pix,
  bairro: 'Mata Do Jacinto',
  // O modelo redigitou a rua: sem o "i" e sem a vírgula.
  endereco: 'Rua Jorge Kalil Dualib 10',
  obs_entrega: 'Pix de R$ 125,00 enviado em 04/09/2026. Há um cachorro no local; chamar o cliente antes da entrega.',
}

describe('por que a trava por ARGUMENTOS não segurou o pedido triplicado', () => {
  it('maiúscula e observação sozinhas NÃO furam a trava — isso já era normalizado', () => {
    const so_cosmetico = { ...pix, bairro: 'MATA DO JACINTO', obs_entrega: 'qualquer outra observação' }
    expect(stableArgsKey(so_cosmetico)).toBe(stableArgsKey(pix))
  })

  it('a forma de pagamento muda de verdade — a trava por argumento não tinha como pegar', () => {
    // Cliente trocou cartão por Pix. Argumento diferente, pedido é o mesmo.
    expect(stableArgsKey(cartao)).not.toBe(stableArgsKey(pix))
  })

  it('o modelo redigitar a rua também escapa da trava por argumento', () => {
    // "Duailibi, 10" × "Dualib 10": humanamente o mesmo endereço, comparação
    // de string não tem como saber.
    expect(stableArgsKey(pix)).not.toBe(stableArgsKey(pixComprovante))
  })

  it('conclusão: nenhum dos três casos é evitável comparando argumento', () => {
    const chaves = new Set([stableArgsKey(cartao), stableArgsKey(pix), stableArgsKey(pixComprovante)])
    // Três chaves distintas = três pedidos criados. É por isso que a trava
    // passou a ser por CONVERSA nas ferramentas que criam algo.
    expect(chaves.size).toBe(3)
  })
})

describe('stableArgsKey — o que ele normaliza de verdade', () => {
  it('ignora a ordem das chaves', () => {
    expect(stableArgsKey({ a: 1, b: 2 })).toBe(stableArgsKey({ b: 2, a: 1 }))
  })

  it('ignora espaço nas pontas e caixa', () => {
    expect(stableArgsKey({ nome: '  Ana  ' })).toBe(stableArgsKey({ nome: 'ana' }))
  })

  it('ignora campos cosméticos (observação, referência, nota)', () => {
    expect(stableArgsKey({ x: 1, obs_entrega: 'a', referencia: 'b' })).toBe(
      stableArgsKey({ x: 1, obs_entrega: 'z', referencia: 'y' }),
    )
  })

  it('NÃO ignora o que muda o pedido de verdade', () => {
    expect(stableArgsKey({ quantidade: 1 })).not.toBe(stableArgsKey({ quantidade: 2 }))
  })
})

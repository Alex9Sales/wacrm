import { describe, expect, it } from 'vitest'

import { pickPipeline } from './default-pipeline'

// Onde o negócio nasce: o primeiro candidato válido vence, na ordem
// pedido > agente > canal > conta. Caso Dentai (22/09): com um WhatsApp por
// operação, tudo caía no funil mais antigo porque só existia o último.
describe('pickPipeline — o primeiro válido vence', () => {
  const PEDIDO = 'p-pedido'
  const AGENTE = 'p-agente'
  const CANAL = 'p-canal'
  const CONTA = 'p-conta'

  it('o que a chamada pediu vence tudo', () => {
    expect(pickPipeline([PEDIDO, AGENTE, CANAL, CONTA])).toBe(PEDIDO)
  })

  it('sem pedido, vale o funil do agente', () => {
    expect(pickPipeline([null, AGENTE, CANAL, CONTA])).toBe(AGENTE)
  })

  it('sem pedido nem agente, vale o funil do CANAL (o ajuste de 22/09)', () => {
    expect(pickPipeline([null, null, CANAL, CONTA])).toBe(CANAL)
  })

  it('sem nada configurado, sobra o funil da conta — como sempre foi', () => {
    expect(pickPipeline([null, undefined, null, CONTA])).toBe(CONTA)
  })

  it('conta sem funil nenhum devolve null (quem chama decide o que fazer)', () => {
    expect(pickPipeline([null, null, null, null])).toBeNull()
  })

  it('string vazia ou só espaço não conta como escolha', () => {
    expect(pickPipeline(['', '   ', CANAL])).toBe(CANAL)
    expect(pickPipeline(['  '])).toBeNull()
  })
})

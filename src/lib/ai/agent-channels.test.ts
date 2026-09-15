import { describe, expect, it } from 'vitest'
import { agentChannelsHealth, removeDeletedChannel } from './agent-channels'

describe('removeDeletedChannel', () => {
  it('tira o apagado quando sobra canal válido (GoLink: 2 ids, 1 válido)', () => {
    expect(removeDeletedChannel(['a', 'b'], 'b', new Set(['a']))).toEqual(['a'])
  })

  it('não mexe quando o id nem estava na lista', () => {
    expect(removeDeletedChannel(['a'], 'z', ['a'])).toBeNull()
    expect(removeDeletedChannel([], 'z', ['a'])).toBeNull()
    expect(removeDeletedChannel(null, 'z', ['a'])).toBeNull()
  })

  it('NUNCA esvazia a lista: o único canal apagado fica (senão vira "todos os canais")', () => {
    expect(removeDeletedChannel(['b'], 'b', ['a', 'c'])).toBeNull()
  })

  it('não mexe quando só sobram outros canais também apagados (Zelia)', () => {
    expect(removeDeletedChannel(['x', 'y', 'b'], 'b', ['a'])).toBeNull()
  })

  it('mantém outros apagados quando ainda há válido (a limpeza deles é do script)', () => {
    expect(removeDeletedChannel(['x', 'a', 'b'], 'b', ['a'])).toEqual(['x', 'a'])
  })

  it('o apagado não conta como válido mesmo se existingIds for de antes do DELETE', () => {
    expect(removeDeletedChannel(['b'], 'b', ['b'])).toBeNull()
    expect(removeDeletedChannel(['b', 'a'], 'b', ['a', 'b'])).toEqual(['a'])
  })

  it('tira repetições do apagado', () => {
    expect(removeDeletedChannel(['b', 'a', 'b'], 'b', ['a'])).toEqual(['a'])
  })
})

describe('agentChannelsHealth', () => {
  it('lista vazia = todos os canais, nada apagado', () => {
    expect(agentChannelsHealth([], ['a'])).toEqual({
      total: 0,
      valid: 0,
      deleted: 0,
      respondsNowhere: false,
    })
  })

  it('CEMA: 1 id, 0 válidos → não responde em canal nenhum', () => {
    expect(agentChannelsHealth(['gone'], ['a', 'b'])).toEqual({
      total: 1,
      valid: 0,
      deleted: 1,
      respondsNowhere: true,
    })
  })

  it('Fluxia: 6 ids, 5 válidos', () => {
    const h = agentChannelsHealth(['a', 'b', 'c', 'd', 'e', 'gone'], new Set(['a', 'b', 'c', 'd', 'e']))
    expect(h).toEqual({ total: 6, valid: 5, deleted: 1, respondsNowhere: false })
  })
})

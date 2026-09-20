import { describe, it, expect } from 'vitest'
import { isEchoOfRecent, normalizeForEcho } from './followup-echo'

const ANTERIOR = 'Combinado, Celso. Na segunda, me diga se conseguiu importar no Exocad ou se apareceu algum erro.'

describe('isEchoOfRecent', () => {
  it('repetir a mesma frase (19/09) é eco', () => {
    expect(isEchoOfRecent(ANTERIOR, [ANTERIOR])).toBe(true)
    expect(isEchoOfRecent('combinado celso na segunda me diga se conseguiu importar no exocad ou se apareceu algum erro', [ANTERIOR])).toBe(true)
  })

  it('a mesma frase sem o começo ainda é eco', () => {
    expect(isEchoOfRecent('Na segunda, me diga se conseguiu importar no Exocad ou se apareceu algum erro.', [ANTERIOR])).toBe(true)
  })

  it('mensagem nova de verdade passa', () => {
    expect(isEchoOfRecent('Celso, qualquer dúvida na importação eu te ajudo por aqui.', [ANTERIOR])).toBe(false)
    expect(isEchoOfRecent('Oi! Tudo certo por aí?', [ANTERIOR])).toBe(false)
  })

  it('texto curtinho não é julgado', () => {
    expect(isEchoOfRecent('ok', ['ok'])).toBe(false)
    expect(normalizeForEcho('Combinado! 😊')).toBe('combinado')
  })
})

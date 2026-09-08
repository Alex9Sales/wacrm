import { describe, expect, it } from 'vitest'

import { nameSearchTiers } from './search-tiers'

describe('busca por nome em camadas', () => {
  it('"Danyela Souza": frase inteira → as duas palavras → só "Danyela"', () => {
    expect(nameSearchTiers('Danyela Souza')).toEqual([['Danyela Souza'], ['Danyela', 'Souza'], ['Danyela']])
  })
  it('um nome só tem uma camada', () => {
    expect(nameSearchTiers('João')).toEqual([['João']])
  })
  it('primeiro nome curto demais não vira camada sozinho ("Jo Silva")', () => {
    expect(nameSearchTiers('Jo Silva')).toEqual([['Jo Silva'], ['Jo', 'Silva']])
  })
  it('limpa curingas do LIKE e espaços', () => {
    expect(nameSearchTiers('  %Ana_ Lima ')).toEqual([['Ana Lima'], ['Ana', 'Lima'], ['Ana']])
    expect(nameSearchTiers('   ')).toEqual([])
  })
})

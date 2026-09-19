import { describe, it, expect } from 'vitest'
import { sortReasons } from './lost-reasons'

describe('sortReasons', () => {
  it('ordem alfabética sem ligar pra caixa e acento, "Outros" no fim', () => {
    expect(
      sortReasons(['Não responde', 'Outros', 'achou caro', 'Comprou concorrente', 'Cadastro incompleto', 'Já é aluno']),
    ).toEqual(['achou caro', 'Cadastro incompleto', 'Comprou concorrente', 'Já é aluno', 'Não responde', 'Outros'])
  })

  it('não mexe na lista original', () => {
    const lista = ['b', 'a']
    sortReasons(lista)
    expect(lista).toEqual(['b', 'a'])
  })
})

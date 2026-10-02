import { describe, it, expect } from 'vitest'
import { sortReasons, filterReasons } from './lost-reasons'

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

describe('filterReasons — busca do "Confirmar perda"', () => {
  const lista = ['Achou caro', 'Cadastro incompleto', 'Comprou concorrente', 'Não responde', 'Preferiu esperar', 'Outros']

  it('busca vazia (ou só espaço) devolve tudo, na mesma ordem', () => {
    expect(filterReasons(lista, '')).toEqual(lista)
    expect(filterReasons(lista, '   ')).toEqual(lista)
  })

  it('sem acento e sem caixa', () => {
    expect(filterReasons(lista, 'nao')).toEqual(['Não responde'])
    expect(filterReasons(lista, 'NÃO RESP')).toEqual(['Não responde'])
    expect(filterReasons(lista, 'CARO')).toEqual(['Achou caro'])
    expect(filterReasons(['Área sem clientes'], 'area')).toEqual(['Área sem clientes'])
  })

  it('pedaço do meio da palavra também acha, mantendo a ordem da lista', () => {
    expect(filterReasons(lista, 'co')).toEqual(['Cadastro incompleto', 'Comprou concorrente'])
    expect(filterReasons(lista, 'es')).toEqual(['Não responde', 'Preferiu esperar'])
  })

  it('todas as palavras têm que aparecer, em qualquer ordem', () => {
    expect(filterReasons(lista, 'inc cad')).toEqual(['Cadastro incompleto'])
    expect(filterReasons(lista, 'cad caro')).toEqual([])
  })

  it('nada bate → lista vazia (a tela mostra "Nenhum motivo com …")', () => {
    expect(filterReasons(lista, 'mudou de cidade')).toEqual([])
  })

  it('não mexe na lista original', () => {
    const copia = [...lista]
    filterReasons(lista, 'caro')
    expect(lista).toEqual(copia)
  })
})

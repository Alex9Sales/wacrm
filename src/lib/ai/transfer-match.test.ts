import { describe, expect, it } from 'vitest'

import { matchRoutingTag } from './transfer-actions'

const t = (tagName: string, userId = tagName) => ({ tagName, userId })
const names = (r: { tagName: string }[]) => r.map((x) => x.tagName)

describe('matchRoutingTag — qual etiqueta a IA quis', () => {
  it('nome exato', () => {
    expect(names(matchRoutingTag([t('Responsável'), t('Gerente')], 'responsavel'))).toEqual(['Responsável'])
  })

  it('IA escreveu a etiqueta com complemento (16/09)', () => {
    expect(names(matchRoutingTag([t('Responsável')], 'responsavel - gas do povo'))).toEqual(['Responsável'])
  })

  it('a mais específica vence e pedaço de palavra não casa', () => {
    expect(names(matchRoutingTag([t('Gerente'), t('Gerente Financeiro')], 'gerente financeiro - boleto atrasado'))).toEqual(['Gerente Financeiro'])
    expect(names(matchRoutingTag([t('TI'), t('Garantia')], 'garantia - troca do botijao'))).toEqual(['Garantia'])
  })

  it('pedaço de UMA etiqueta casa; ambíguo não casa', () => {
    expect(names(matchRoutingTag([t('Gerente Financeiro'), t('Suporte')], 'financeiro'))).toEqual(['Gerente Financeiro'])
    expect(matchRoutingTag([t('Gerente Financeiro'), t('Gerente Comercial')], 'gerente')).toEqual([])
  })

  it('vários atendentes na mesma etiqueta continuam no rodízio', () => {
    expect(matchRoutingTag([t('Responsável', 'a'), t('Responsável', 'b')], 'responsavel')).toHaveLength(2)
  })

  it('nada casa', () => {
    expect(matchRoutingTag([t('Responsável')], 'financeiro')).toEqual([])
    expect(matchRoutingTag([t('Responsável')], '')).toEqual([])
  })
})

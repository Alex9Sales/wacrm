import { describe, it, expect } from 'vitest'
import { parseCloseDirectives } from './defaults'

describe('parseCloseDirectives', () => {
  it('extrai skip/etiqueta/resolver/funil e limpa o texto', () => {
    const raw =
      'Valeu, até mais!\n[[RESOLVER]]\n[[FUNIL:Perdido]]\n[[ETIQUETA:Frio]] [[ETIQUETA:Sem interesse]]'
    const d = parseCloseDirectives(raw)
    expect(d.resolve).toBe(true)
    expect(d.funnelStage).toBe('Perdido')
    expect(d.tags).toEqual(['Frio', 'Sem interesse'])
    expect(d.skipReply).toBe(false)
    expect(d.text).toBe('Valeu, até mais!')
  })

  it('detecta [[IGNORAR]] (skip)', () => {
    const d = parseCloseDirectives('[[IGNORAR]]')
    expect(d.skipReply).toBe(true)
    expect(d.text).toBe('')
  })

  it('extrai [[AGENDAR:data|título]]', () => {
    const d = parseCloseDirectives(
      'Combinado! Te vejo amanhã.\n[[AGENDAR:2026-08-16T15:00|Reunião com Matheus]]',
    )
    expect(d.schedule).toEqual({
      startsLocal: '2026-08-16T15:00',
      title: 'Reunião com Matheus',
    })
    expect(d.text).toBe('Combinado! Te vejo amanhã.')
  })

  it('extrai [[TRANSFERIR:etiqueta|resumo]]', () => {
    const d = parseCloseDirectives(
      'Vou te passar pro gerente, um instante!\n[[TRANSFERIR:Gerente|Cliente quer negociar desconto grande]]',
    )
    expect(d.transfer).toEqual({
      tag: 'Gerente',
      summary: 'Cliente quer negociar desconto grande',
    })
    expect(d.text).toBe('Vou te passar pro gerente, um instante!')
  })

  it('extrai [[CRIARCARD:título]]', () => {
    const d = parseCloseDirectives(
      'Show! Vou registrar aqui.\n[[CRIARCARD:Matheus - interesse plano Pro]]',
    )
    expect(d.createCard).toBe('Matheus - interesse plano Pro')
    expect(d.text).toBe('Show! Vou registrar aqui.')
  })

  it('extrai nota/atributo/voz', () => {
    const d = parseCloseDirectives(
      'Anotado!\n[[NOTA:cliente pediu desconto]]\n[[ATRIBUTO:Qualificação=Quente]]\n[[VOZ:audio]]',
    )
    expect(d.note).toBe('cliente pediu desconto')
    expect(d.attribute).toEqual({ field: 'Qualificação', value: 'Quente' })
    expect(d.voicePref).toBe('audio')
    expect(d.text).toBe('Anotado!')
  })

  it('[[VOZ:texto]] → text', () => {
    expect(parseCloseDirectives('[[VOZ:texto]]').voicePref).toBe('text')
  })

  it('sem marcadores = texto intacto', () => {
    const d = parseCloseDirectives('Oi, tudo bem?')
    expect(d).toMatchObject({
      resolve: false,
      skipReply: false,
      funnelStage: null,
      tags: [],
      text: 'Oi, tudo bem?',
    })
  })
})

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

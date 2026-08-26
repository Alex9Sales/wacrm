import { describe, it, expect } from 'vitest'
import { parseCloseDirectives, buildSystemPrompt } from './defaults'

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
    expect(d.createCard).toEqual({
      title: 'Matheus - interesse plano Pro',
      value: null,
      note: null,
    })
    expect(d.text).toBe('Show! Vou registrar aqui.')
  })

  it('extrai [[CRIARCARD:título | valor | observação]]', () => {
    const d = parseCloseDirectives(
      'Pedido confirmado!\n[[CRIARCARD:Zulma — botijão P-13 | R$ 125,00 | 1 Ultragaz P-13 · Rua Farol 37 · cartão]]',
    )
    expect(d.createCard).toEqual({
      title: 'Zulma — botijão P-13',
      value: 125,
      note: '1 Ultragaz P-13 · Rua Farol 37 · cartão',
    })
    expect(d.text).toBe('Pedido confirmado!')
  })

  it('CRIARCARD com valor ilegível vira null (não trava o card)', () => {
    const d = parseCloseDirectives('[[CRIARCARD:Lead novo | a combinar]]')
    expect(d.createCard).toEqual({ title: 'Lead novo', value: null, note: null })
  })

  it('extrai [[AGENTE:nome | resumo]] (roteamento multiagente)', () => {
    const d = parseCloseDirectives(
      '[[AGENTE:Agente de Vendas|Empresa X, 4 atendentes, quer o plano Pro]]',
    )
    expect(d.routeAgent).toEqual({
      name: 'Agente de Vendas',
      summary: 'Empresa X, 4 atendentes, quer o plano Pro',
    })
    expect(d.text).toBe('')
  })

  it('[[AGENTE]] sem resumo também vale', () => {
    const d = parseCloseDirectives('Um instante!\n[[AGENTE:Suporte]]')
    expect(d.routeAgent).toEqual({ name: 'Suporte', summary: '' })
    expect(d.text).toBe('Um instante!')
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

  it('extrai [[PERDER:motivo]] (perde-em-pé) e limpa o texto', () => {
    const d = parseCloseDirectives('Sem problemas, obrigado!\n[[PERDER:Achou caro]]')
    expect(d.lose).toEqual({ reason: 'Achou caro' })
    expect(d.funnelStage).toBeNull()
    expect(d.text).toBe('Sem problemas, obrigado!')
  })

  it('[[PERDER]] sem motivo → reason vazio (vira default no apply)', () => {
    const d = parseCloseDirectives('Até mais!\n[[PERDER]]')
    expect(d.lose).toEqual({ reason: '' })
    expect(d.text).toBe('Até mais!')
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

describe('buildSystemPrompt — contato da conversa', () => {
  it('JID antigo sem o nono dígito → telefone de consulta ganha o 9 (caso Day Manicure)', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: 'Day Manicure', phone: '556793431165' },
    })
    expect(p).toContain('phone: 556793431165')
    expect(p).toContain('67993431165') // 67 9 9343-1165 — como o ERP guarda
  })

  it('número já com 11 dígitos locais fica intacto (só tira o 55)', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: null, phone: '5567991252907' },
    })
    expect(p).toContain('67991252907')
    expect(p).not.toContain('679991252907')
  })
})

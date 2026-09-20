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

  it('[[TRANSFERIR]] com "]" e quebra de linha no resumo continua casando (e sai do texto)', () => {
    const d = parseCloseDirectives(
      'Perfeito! Já passo pro responsável 😊\n[[TRANSFERIR:Responsável|Carla [Gás do Povo], CPF 12345678909,\nentrega]]',
    )
    expect(d.transfer).toEqual({ tag: 'Responsável', summary: 'Carla [Gás do Povo], CPF 12345678909,\nentrega' })
    expect(d.text).toBe('Perfeito! Já passo pro responsável 😊')
  })

  it('[[TRANSFERIR]] com resumo terminando em "]" não deixa colchete sobrando', () => {
    const d = parseCloseDirectives('Perfeito!\n[[TRANSFERIR:Responsável|Carla [Gás do Povo]]]')
    expect(d.transfer?.summary).toBe('Carla [Gás do Povo]')
    expect(d.text).toBe('Perfeito!')
  })

  it('[[TRANSFERIR]] seguido de outro marcador não engole o texto do meio', () => {
    const d = parseCloseDirectives('[[TRANSFERIR:X|a]] texto do meio [[NOTA:b]]')
    expect(d.transfer?.summary).toBe('a')
    expect(d.note).toBe('b')
    expect(d.text).toBe('texto do meio')
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
      'Pedido confirmado!\n[[CRIARCARD:Carla Teste — botijão P-13 | R$ 125,00 | 1 Ultragaz P-13 · Rua Exemplo 123 · cartão]]',
    )
    expect(d.createCard).toEqual({
      title: 'Carla Teste — botijão P-13',
      value: 125,
      note: '1 Ultragaz P-13 · Rua Exemplo 123 · cartão',
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
  it('JID antigo sem o nono dígito → telefone de consulta ganha o 9 (caso 26/08)', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: 'Carla Teste', phone: '556790001234' },
    })
    expect(p).toContain('phone: 556790001234')
    expect(p).toContain('67990001234') // 67 9 9000-1234 — como o ERP guarda
  })

  it('número já com 11 dígitos locais fica intacto (só tira o 55)', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: null, phone: '5567990005678' },
    })
    expect(p).toContain('67990005678')
    expect(p).not.toContain('679990005678')
  })

  it('não perde venda: histórico de outra conversa entra como PRIOR CONTEXT', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      priorContactContext: '[27/08 15:15] Cliente: Qual valor do gás?\n[27/08 15:18] Cliente: vou ver e já te falo',
    })
    expect(p).toContain('PRIOR CONTEXT')
    expect(p).toContain('vou ver e já te falo')
    // Pesquisar em dois canais nossos NÃO baixa o preço (Alex, 20/09).
    expect(p).toContain('quote the SAME price and conditions')
    expect(p).not.toContain('PROACTIVELY offer the available discount')
  })

  it('sem priorContactContext, nada de PRIOR CONTEXT no prompt', () => {
    const p = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(p).not.toContain('PRIOR CONTEXT')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { parseCloseDirectives, parseModoAgendamento, buildSystemPrompt, moveCardInstruction } from './defaults'

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
      // Sem 3º campo = agenda padrão da conta. Quem tem uma agenda só nem
      // precisa saber que este campo existe.
      profissional: null,
    })
    expect(d.text).toBe('Combinado! Te vejo amanhã.')
  })

  it('extrai o PROFISSIONAL no 3º campo — clínica com várias agendas', () => {
    // 30/09 (Dra. Joyce, 10 dentistas): sem isto, todo paciente caía na mesma
    // agenda, independentemente de com quem a consulta foi combinada.
    const d = parseCloseDirectives(
      'Marquei! Até quarta.\n[[AGENDAR:2026-10-01T10:00|Avaliação · Ana Souza|Dra. Bruna Diodatti]]',
    )
    expect(d.schedule).toEqual({
      startsLocal: '2026-10-01T10:00',
      title: 'Avaliação · Ana Souza',
      profissional: 'Dra. Bruna Diodatti',
    })
    expect(d.text).toBe('Marquei! Até quarta.')
  })

  it('3º campo vazio não vira profissional', () => {
    const d = parseCloseDirectives('ok\n[[AGENDAR:2026-10-01T10:00|Avaliação|]]')
    expect(d.schedule?.profissional).toBeNull()
    expect(d.schedule?.title).toBe('Avaliação')
  })

  // 02/10/2026: o 4º campo diz o que fazer com quem JÁ TEM consulta — "nova"
  // (adicional, nunca move) ou "remarca X" (move exatamente a de X). Sem ele,
  // o marcador continua igual ao de sempre (nem a chave `modo` existe).
  it('3 campos: sem `modo` — o marcador de sempre', () => {
    const d = parseCloseDirectives('Marquei!\n[[AGENDAR:2026-10-21T10:00|Avaliação · Léo|Dra. Marta Teixeira]]')
    expect(d.schedule).toEqual({
      startsLocal: '2026-10-21T10:00',
      title: 'Avaliação · Léo',
      profissional: 'Dra. Marta Teixeira',
    })
    expect(d.schedule && 'modo' in d.schedule).toBe(false)
  })

  it('4º campo "nova": consulta ADICIONAL, com profissional', () => {
    const d = parseCloseDirectives('Marquei a da sua filha também!\n[[AGENDAR:2026-10-21T10:00|Limpeza · Nina|Dra. Marta Teixeira|nova]]')
    expect(d.schedule).toEqual({
      startsLocal: '2026-10-21T10:00',
      title: 'Limpeza · Nina',
      profissional: 'Dra. Marta Teixeira',
      modo: { tipo: 'nova' },
    })
    expect(d.text).toBe('Marquei a da sua filha também!')
  })

  it('3º campo vazio com 4º campo: "|título||nova"', () => {
    const d = parseCloseDirectives('ok\n[[AGENDAR:2026-10-21T10:00|Limpeza||nova]]')
    expect(d.schedule).toEqual({
      startsLocal: '2026-10-21T10:00',
      title: 'Limpeza',
      profissional: null,
      modo: { tipo: 'nova' },
    })
    expect(d.text).toBe('ok')
  })

  it('4º campo "remarca YYYY-MM-DDTHH:MM": diz QUAL consulta mover', () => {
    const d = parseCloseDirectives(
      'Remarquei para sexta!\n[[AGENDAR:2026-10-23T14:00|Avaliação · Léo|Dra. Marta Teixeira|remarca 2026-10-21T09:30]]',
    )
    expect(d.schedule).toEqual({
      startsLocal: '2026-10-23T14:00',
      title: 'Avaliação · Léo',
      profissional: 'Dra. Marta Teixeira',
      modo: { tipo: 'remarca', deLocal: '2026-10-21T09:30' },
    })
    expect(d.text).toBe('Remarquei para sexta!')
  })

  it('"remarca" com espaço no lugar do T e sem profissional', () => {
    const d = parseCloseDirectives('ok [[AGENDAR:2026-10-23 14:00|Avaliação||remarca 2026-10-21 09:30]]')
    expect(d.schedule?.modo).toEqual({ tipo: 'remarca', deLocal: '2026-10-21T09:30' })
    expect(d.schedule?.profissional).toBeNull()
  })

  it('"remarca" SEM data não vira o comportamento de sempre (que moveria a mais próxima)', () => {
    const d = parseCloseDirectives('ok [[AGENDAR:2026-10-23T14:00|Avaliação||remarca]]')
    expect(d.schedule?.modo).toEqual({ tipo: 'remarca', deLocal: null })
  })

  it('4º campo que não dá para entender: segue o de sempre (sem `modo`)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = parseCloseDirectives('ok [[AGENDAR:2026-10-23T14:00|Avaliação|Dra. Marta|qualquer coisa]]')
    expect(d.schedule?.profissional).toBe('Dra. Marta')
    expect(d.schedule && 'modo' in d.schedule).toBe(false)
    expect(d.text).toBe('ok')
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

  // 01/10 (Zelo): lead fora da área perdido com motivo LIMPO (casa com a lista
  // da conta e com o RD) + comentário com o detalhe.
  it('[[PERDER:motivo | comentário]] separa no 1º "|" e limpa o texto', () => {
    const d = parseCloseDirectives(
      'Obrigada pelo interesse! Por enquanto não atendemos sua região.\n' +
        '[[PERDER:Área sem clientes | Lead fora da área — cidade de interesse: Cidade X/UF · capital até R$ 25 mil]]',
    )
    expect(d.lose).toEqual({
      reason: 'Área sem clientes',
      note: 'Lead fora da área — cidade de interesse: Cidade X/UF · capital até R$ 25 mil',
    })
    expect(d.text).toBe('Obrigada pelo interesse! Por enquanto não atendemos sua região.')
  })

  it('o comentário pode ter outros "|" — só o 1º separa', () => {
    const d = parseCloseDirectives('[[PERDER:Sem orçamento | capital baixo | volta em 2027]]')
    expect(d.lose).toEqual({ reason: 'Sem orçamento', note: 'capital baixo | volta em 2027' })
  })

  it('comentário vazio depois do "|" → sem a chave note (nem undefined)', () => {
    const d = parseCloseDirectives('[[PERDER:Achou caro | ]]')
    expect(d.lose).toEqual({ reason: 'Achou caro' })
    expect(d.lose).not.toHaveProperty('note')
  })

  it('um "]" dentro do comentário não impede a perda nem vaza o marcador', () => {
    // Com [^\]] o marcador não casava: perda não acontecia e ele ia cru pro cliente.
    const d = parseCloseDirectives(
      'Tudo bem, obrigado!\n[[PERDER:Área sem clientes | interesse em [cidade fora] · capital [até 25 mil]]]',
    )
    expect(d.lose).toEqual({
      reason: 'Área sem clientes',
      note: 'interesse em [cidade fora] · capital [até 25 mil]',
    })
    expect(d.text).toBe('Tudo bem, obrigado!')
  })

  it('dois marcadores na MESMA linha: o PERDER para no "]]" dele', () => {
    const d = parseCloseDirectives(
      'Vou te passar pra equipe. [[PERDER:Fora do perfil | quer serviço avulso]] [[FUNIL:3. Comercial | Serviços > Novo lead]] [[RESOLVER]]',
    )
    expect(d.lose).toEqual({ reason: 'Fora do perfil', note: 'quer serviço avulso' })
    expect(d.funnelStage).toBe('3. Comercial | Serviços > Novo lead')
    expect(d.resolve).toBe(true)
    expect(d.text).toBe('Vou te passar pra equipe.')
  })

  it('[[PERDER]] e [[PERDER:x]] na mesma linha de outro texto', () => {
    expect(parseCloseDirectives('ok [[PERDER]] [[NOTA:sem retorno]]').lose).toEqual({ reason: '' })
    const d = parseCloseDirectives('Até! [[PERDER: Achou caro ]] Abraço')
    expect(d.lose).toEqual({ reason: 'Achou caro' })
    expect(d.text).toBe('Até!  Abraço')
  })

  it('marcador fechado errado não engole o marcador seguinte como motivo', () => {
    const d = parseCloseDirectives('Até! [[PERDER:Achou caro] [[RESOLVER]]')
    expect(d.lose).toBeNull()
    expect(d.resolve).toBe(true)
  })

  it('marcador sem fechamento não engole as linhas seguintes', () => {
    const d = parseCloseDirectives('[[PERDER:Achou caro\nSegunda linha [[RESOLVER]]')
    expect(d.lose).toBeNull()
    expect(d.resolve).toBe(true)
  })

  it('comentário na linha de baixo ainda perde (o regex antigo aceitava)', () => {
    const d = parseCloseDirectives('Combinado!\n[[PERDER:Área sem clientes |\ncidade de interesse: Cidade X/UF]]')
    expect(d.lose).toEqual({ reason: 'Área sem clientes', note: 'cidade de interesse: Cidade X/UF' })
    expect(d.text).toBe('Combinado!')
  })

  it('só o comentário (motivo vazio) → reason vazio + note', () => {
    expect(parseCloseDirectives('[[PERDER: | só detalhe]]').lose).toEqual({ reason: '', note: 'só detalhe' })
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

  // 25/09: um agente que identifica a pessoa por e-mail (plataforma de curso,
  // área de membros) só recebia o telefone aqui — e acabava PERGUNTANDO o
  // e-mail a quem já está cadastrado.
  it('e-mail do cadastro entra no prompt, para a ferramenta não precisar perguntar', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: 'Aluno Teste', phone: '5511999990000', email: 'aluno@exemplo.com' },
    })
    expect(p).toContain('email: aluno@exemplo.com')
    expect(p).toMatch(/only ask the customer for their e-mail when none is listed/i)
  })

  it('contato SEM e-mail não ganha linha de e-mail nenhuma', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: 'Aluno Teste', phone: '5511999990000' },
    })
    expect(p).not.toContain('email:')
  })

  it('só o e-mail já basta para o bloco do contato existir', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      contact: { name: null, phone: null, email: 'so-email@exemplo.com' },
    })
    expect(p).toContain('CONTACT OF THIS CONVERSATION')
    expect(p).toContain('so-email@exemplo.com')
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

// 01/10 (Zelo): a IA só recebia a LISTA de etapas e as regras do prompt da
// conta dependem de onde o card está agora.
describe('moveCardInstruction / buildSystemPrompt — etapa atual do card', () => {
  const stages = ['Novo lead', 'Qualificado', 'Reunião agendada']

  it('diz em que etapa o card ESTÁ quando conhecida', () => {
    const t = moveCardInstruction(stages, 'Qualificado')
    expect(t).toContain('Novo lead → Qualificado → Reunião agendada.')
    expect(t).toContain('The card is currently at stage: "Qualificado".')
  })

  it('sem etapa conhecida (null/vazia) a instrução fica como sempre foi', () => {
    for (const cur of [undefined, null, '', '   ']) {
      expect(moveCardInstruction(stages, cur)).not.toContain('currently at stage')
    }
  })

  it('ensina o comentário depois do "|" no [[PERDER]]', () => {
    expect(moveCardInstruction(stages)).toContain('[[PERDER:<short reason> | <comment>]]')
  })

  it('buildSystemPrompt repassa currentStage pra instrução de mover card', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      tools: ['move_card'],
      pipelineStages: stages,
      currentStage: 'Reunião agendada',
    })
    expect(p).toContain('The card is currently at stage: "Reunião agendada".')
  })

  it('sem a ferramenta move_card, nem a etapa atual entra', () => {
    const p = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      tools: [],
      pipelineStages: stages,
      currentStage: 'Qualificado',
    })
    expect(p).not.toContain('currently at stage')
  })
})

describe('parseModoAgendamento (4º campo do [[AGENDAR]])', () => {
  it('vazio = sem modo (o de sempre)', () => {
    expect(parseModoAgendamento(undefined)).toBeNull()
    expect(parseModoAgendamento('   ')).toBeNull()
  })

  it('o modelo escreve "nova" de vários jeitos', () => {
    for (const t of ['nova', 'Novo', 'NOVA consulta', 'adicional', 'outra', 'mantém a outra']) {
      expect(parseModoAgendamento(t)).toEqual({ tipo: 'nova' })
    }
  })

  it('remarcação: pega a data de qualquer jeito que venha', () => {
    expect(parseModoAgendamento('remarca 2026-10-21T09:30')).toEqual({ tipo: 'remarca', deLocal: '2026-10-21T09:30' })
    expect(parseModoAgendamento('Remarcar 2026-10-21 09:30')).toEqual({ tipo: 'remarca', deLocal: '2026-10-21T09:30' })
    expect(parseModoAgendamento('mudar 2026-10-21T09:30')).toEqual({ tipo: 'remarca', deLocal: '2026-10-21T09:30' })
    // Data solta, sem palavra: é a consulta a mover.
    expect(parseModoAgendamento('2026-10-21T09:30')).toEqual({ tipo: 'remarca', deLocal: '2026-10-21T09:30' })
  })

  it('texto qualquer = null (não inventa um modo)', () => {
    expect(parseModoAgendamento('confirmado')).toBeNull()
  })
})

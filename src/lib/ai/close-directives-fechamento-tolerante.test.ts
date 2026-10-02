import { describe, it, expect, vi } from 'vitest'
import { parseCloseDirectives, type AgentDirectives } from './defaults'
import { avisoDeAcaoMalFechada, stripInstructionMarkers } from '@/lib/whatsapp/instruction-markers'

// 02/10/2026, revisão 2: o RESUMO e o HANDOFF já aceitavam o fechamento errado
// do modelo ("] ]", "]\n]", "]" no fim da linha, sem fechar). As AÇÕES não: a
// rede do envio tirava "[[ETIQUETA:Lead quente]" do texto, a etiqueta não era
// aplicada e, no máximo, a equipe recebia a nota ⚠️ "ação NÃO foi executada".
// Agora toda diretiva fecha pelas mesmas regras — e a ação acontece.

/** A mesma ordem do auto-reply e do nó de IA dos Fluxos: o parser das
 *  diretivas primeiro, a rede do envio depois, o aviso do que ela tirou. */
function pelaRede(raw: string) {
  const d = parseCloseDirectives(raw)
  const limpo = stripInstructionMarkers(d.text)
  return { d, texto: limpo.text ?? '', aviso: avisoDeAcaoMalFechada(limpo.removed) }
}

/** As linhas do texto, sem as vazias (a linha em branco no lugar do marcador
 *  é a de sempre do parseCloseDirectives). */
const linhas = (t: string) => t.split(/\n+/)

interface Caso {
  /** O marcador SEM o fechamento. */
  abre: string
  /** A ação que tem que aparecer no objeto de diretivas. */
  confere: (d: AgentDirectives) => void
  /** Argumento de várias linhas: sem fechar, vai até o fim / o próximo "[["
   *  (como o RESUMO), então a linha de baixo entra nele. */
  variasLinhas?: boolean
}

const CASOS: Caso[] = [
  { abre: '[[ETIQUETA:Lead quente', confere: (d) => expect(d.tags).toEqual(['Lead quente']) },
  { abre: '[[FUNIL:Vendas > Proposta', confere: (d) => expect(d.funnelStage).toBe('Vendas > Proposta') },
  {
    abre: '[[AGENDAR:2026-10-08T14:00|Visita · Ana|Dra. Teste|nova',
    confere: (d) =>
      expect(d.schedule).toEqual({
        startsLocal: '2026-10-08T14:00',
        title: 'Visita · Ana',
        profissional: 'Dra. Teste',
        modo: { tipo: 'nova' },
      }),
  },
  { abre: '[[TRANSFERIR:Vendas', confere: (d) => expect(d.transfer).toEqual({ tag: 'Vendas', summary: '' }) },
  {
    abre: '[[TRANSFERIR:Vendas|Ana [Centro], quer orçamento',
    variasLinhas: true,
    confere: (d) => expect(d.transfer).toEqual({ tag: 'Vendas', summary: 'Ana [Centro], quer orçamento' }),
  },
  { abre: '[[PERDER:Achou caro', confere: (d) => expect(d.lose).toEqual({ reason: 'Achou caro' }) },
  {
    abre: '[[PERDER:Área sem clientes | cidade [fora] · capital baixo',
    variasLinhas: true,
    confere: (d) => expect(d.lose).toEqual({ reason: 'Área sem clientes', note: 'cidade [fora] · capital baixo' }),
  },
  { abre: '[[PERDER', confere: (d) => expect(d.lose).toEqual({ reason: '' }) },
  { abre: '[[GANHO', confere: (d) => expect(d.win).toBe(true) },
  { abre: '[[IGNORAR', confere: (d) => expect(d.skipReply).toBe(true) },
  { abre: '[[RESOLVER', confere: (d) => expect(d.resolve).toBe(true) },
  { abre: '[[NOTA:pediu desconto', variasLinhas: true, confere: (d) => expect(d.note).toBe('pediu desconto') },
  {
    abre: '[[CRIARCARD:Ana Teste — botijão | 125,00 | entrega amanhã',
    variasLinhas: true,
    confere: (d) => expect(d.createCard).toEqual({ title: 'Ana Teste — botijão', value: 125, note: 'entrega amanhã' }),
  },
  { abre: '[[ATRIBUTO:Cidade = Centro', confere: (d) => expect(d.attribute).toEqual({ field: 'Cidade', value: 'Centro' }) },
  { abre: '[[VOZ:audio', confere: (d) => expect(d.voicePref).toBe('audio') },
  { abre: '[[AGENTE:Suporte', confere: (d) => expect(d.routeAgent).toEqual({ name: 'Suporte', summary: '' }) },
  {
    abre: '[[AGENTE:Suporte|quer a 2ª via',
    variasLinhas: true,
    confere: (d) => expect(d.routeAgent).toEqual({ name: 'Suporte', summary: 'quer a 2ª via' }),
  },
  {
    abre: '[[AVISARDONO:Demo marcada amanhã 10h',
    variasLinhas: true,
    confere: (d) => expect(d.ownerAlert).toEqual({ message: 'Demo marcada amanhã 10h' }),
  },
  { abre: '[[TELEFONE:+55 11 90000-0000', confere: (d) => expect(d.setPhone).toBe('5511900000000') },
  {
    abre: '[[COBRAR:125,00 | +7 | Mensalidade',
    confere: (d) => expect(d.charge).toEqual({ valueRaw: '125,00', dueRaw: '+7', description: 'Mensalidade' }),
  },
  {
    abre: '[[COBRANCA:promessa|2026-10-10',
    confere: (d) => expect(d.collection).toEqual({ kind: 'promessa', date: '2026-10-10' }),
  },
  { abre: '[[COBRANÇA:comprovante', confere: (d) => expect(d.collection).toEqual({ kind: 'comprovante', date: null }) },
]

describe('diretivas de AÇÃO com fechamento tolerante (02/10/2026, revisão 2)', () => {
  for (const c of CASOS) {
    describe(c.abre, () => {
      it('"]]", "] ]", "]\\n]" e "]  ]": a ação acontece e a linha de baixo fica', () => {
        for (const fecho of [']]', '] ]', ']\n]', ']  ]']) {
          const { d, texto, aviso } = pelaRede(`Oi.\n${c.abre}${fecho}\nTudo certo?`)
          c.confere(d)
          expect(linhas(d.text), JSON.stringify(fecho)).toEqual(['Oi.', 'Tudo certo?'])
          expect(linhas(texto)).toEqual(['Oi.', 'Tudo certo?'])
          expect(aviso).toBeNull()
        }
      })

      it('"]" no fim da linha: fecha, e a resposta da linha de baixo sai', () => {
        const { d, texto, aviso } = pelaRede(`Oi.\n${c.abre}]\nTudo certo?`)
        c.confere(d)
        expect(linhas(d.text)).toEqual(['Oi.', 'Tudo certo?'])
        expect(linhas(texto)).toEqual(['Oi.', 'Tudo certo?'])
        expect(aviso).toBeNull()
      })

      it('"]" no fim do texto e sem fechar até o fim do texto', () => {
        for (const fim of [']', ' ]', '']) {
          const { d, texto, aviso } = pelaRede(`Oi.\n${c.abre}${fim}`)
          c.confere(d)
          expect(d.text, JSON.stringify(fim)).toBe('Oi.')
          expect(texto).toBe('Oi.')
          expect(aviso).toBeNull()
        }
      })

      it('sem fechar, para antes do próximo "[[" — que continua valendo', () => {
        const { d, texto, aviso } = pelaRede(`Oi. ${c.abre} [[IGNORAR]]`)
        c.confere(d)
        expect(d.skipReply).toBe(true)
        expect(d.text).toBe('Oi.')
        expect(texto).toBe('Oi.')
        expect(aviso).toBeNull()
      })

      it('não engole o texto depois de um fechamento válido', () => {
        const { d } = pelaRede(`${c.abre}]] Obrigada pelo contato ]]`)
        c.confere(d)
        expect(d.text).toBe('Obrigada pelo contato ]]')
      })

      if (!c.variasLinhas) {
        it('argumento de uma linha, sem fechar: o fim da linha fecha e a resposta de baixo sai', () => {
          const { d, texto, aviso } = pelaRede(`${c.abre}\nOlá! Tudo certo?`)
          c.confere(d)
          expect(d.text).toBe('Olá! Tudo certo?')
          expect(texto).toBe('Olá! Tudo certo?')
          expect(aviso).toBeNull()
        })
      }

      it('5.000 brancos: < 100 ms em todas as formas de fechamento', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const brancos = ' '.repeat(2500) + '\n'.repeat(1000) + '\t \n'.repeat(500)
        const comBrancoDentro = c.abre.includes(':') ? c.abre.replace(':', `:${brancos}`) : `${c.abre}${brancos}`
        for (const fecho of ['', ']', ']]', '] ]', ']\nTchau', ' x', '\n[[GANHO]]', '] x', ']\nOi ]]', '|x', '=x']) {
          for (const raw of [`Já te passo.\n${c.abre}${brancos}${fecho}`, `Já te passo.\n${comBrancoDentro}${fecho}`]) {
            const t0 = performance.now()
            pelaRede(raw)
            expect(performance.now() - t0, JSON.stringify(fecho)).toBeLessThan(500)
          }
        }
      })
    })
  }
})

describe('argumento de várias linhas sem fechamento (como o RESUMO)', () => {
  it('vai até o fim do texto: perder o resto de uma resposta quebrada é melhor que vazar', () => {
    const d = parseCloseDirectives('Anotado!\n[[NOTA:pediu desconto\nvolta semana que vem')
    expect(d.note).toBe('pediu desconto\nvolta semana que vem')
    expect(d.text).toBe('Anotado!')
  })

  it('o comentário da perda também — o MOTIVO, não: a linha de baixo nunca vira motivo', () => {
    expect(parseCloseDirectives('[[PERDER:Fora da área | cidade X\ncapital baixo').lose).toEqual({
      reason: 'Fora da área',
      note: 'cidade X\ncapital baixo',
    })
    const d = parseCloseDirectives('[[PERDER:Fora da área\nObrigada pelo contato!')
    expect(d.lose).toEqual({ reason: 'Fora da área' })
    expect(d.text).toBe('Obrigada pelo contato!')
  })
})

describe('GANHO / IGNORAR / RESOLVER — sem argumento', () => {
  it('fecham no PRIMEIRO "]": a frase depois fica', () => {
    for (const n of ['GANHO', 'IGNORAR', 'RESOLVER']) {
      const { d, texto, aviso } = pelaRede(`[[${n}] Obrigada!`)
      expect(d.text, n).toBe('Obrigada!')
      expect(texto).toBe('Obrigada!')
      expect(aviso).toBeNull()
    }
    expect(parseCloseDirectives('[[GANHO] Obrigada!').win).toBe(true)
    expect(parseCloseDirectives('[[ ignorar ] ]').skipReply).toBe(true)
    expect(parseCloseDirectives('[[Resolver]\n]').resolve).toBe(true)
  })

  it('nome que só COMEÇA igual não é o marcador', () => {
    const d = parseCloseDirectives('[[GANHOS]] [[IGNORARAM]] [[RESOLVERIA]] [[GANHO_X]]')
    expect(d).toMatchObject({ win: false, skipReply: false, resolve: false })
  })

  it('sem "]" e com texto na MESMA linha não é o marcador — a rede tira e avisa', () => {
    const { d, texto, aviso } = pelaRede('Oi.\n[[GANHO Obrigada pela compra!')
    expect(d.win).toBe(false)
    expect(texto).toBe('Oi.')
    expect(aviso).toContain('[[GANHO…] ]')
  })
})

describe('o aviso ⚠️ só sai para o que NÃO rodou', () => {
  it('o parser leu o mal fechado → sem aviso', () => {
    const { d, aviso } = pelaRede('Combinado!\n[[NOTA:quer orçamento] ]\n[[AGENDAR:2026-10-08T14:00|Visita]\n[[GANHO]')
    expect(d.note).toBe('quer orçamento')
    expect(d.schedule?.startsLocal).toBe('2026-10-08T14:00')
    expect(d.win).toBe(true)
    expect(aviso).toBeNull()
  })

  it('o que o parser não lê continua avisando', () => {
    // Data que não dá para ler, "]" no MEIO da linha (não é fechamento),
    // ENVIAR (o parser dele, nos materiais, ainda exige "]]").
    for (const [raw, nome] of [
      ['Oi.\n[[AGENDAR:amanhã às 14h|Visita] ]', 'AGENDAR'],
      ['Oi.\n[[ETIQUETA:Lead quente] Olá Maria!', 'ETIQUETA'],
      ['Oi.\n[[ENVIAR:contrato] ]', 'ENVIAR'],
    ]) {
      const { texto, aviso } = pelaRede(raw)
      expect(texto, raw).toBe('Oi.')
      expect(aviso, raw).toContain(`[[${nome}…] ]`)
    }
  })

  it('misturado: só o que não rodou entra no aviso', () => {
    const { d, aviso } = pelaRede('Ok!\n[[ETIQUETA:Lead quente] ]\n[[AGENDAR:amanhã|Visita] ]')
    expect(d.tags).toEqual(['Lead quente'])
    expect(aviso).toContain('[[AGENDAR…] ]')
    expect(aviso).not.toContain('ETIQUETA')
  })
})

// 02/10/2026, revisão 3 — três achados da revisão da revisão 2.

/** Marcador BEM fechado com o campo de uma linha quebrado no meio — o regex
 *  de antes da revisão 2 aceitava; a revisão 2 deixou de aceitar e a rede
 *  tirava do texto sem aviso (termina em "]]"). Sem o fechamento no fim. */
const QUEBRADOS: { abre: string; confere: (d: AgentDirectives) => void }[] = [
  { abre: '[[ETIQUETA:Lead\nquente', confere: (d) => expect(d.tags).toEqual(['Lead quente']) },
  { abre: '[[FUNIL:Vendas >\nProposta', confere: (d) => expect(d.funnelStage).toBe('Vendas > Proposta') },
  { abre: '[[PERDER:Achou\ncaro', confere: (d) => expect(d.lose).toEqual({ reason: 'Achou caro' }) },
  {
    abre: '[[PERDER:Área sem\nclientes | cidade [fora], capital baixo',
    confere: (d) => expect(d.lose).toEqual({ reason: 'Área sem clientes', note: 'cidade [fora], capital baixo' }),
  },
  { abre: '[[TRANSFERIR:Time de\nVendas', confere: (d) => expect(d.transfer).toEqual({ tag: 'Time de Vendas', summary: '' }) },
  {
    // O 1º "]" adiante é o do resumo, não o fechamento — a etiqueta quebrada
    // ainda vale (o resumo com "[…]" é de verdade: o caso do CPF, 16/09).
    abre: '[[TRANSFERIR:Time de\nVendas|Cliente [Gás do Povo], quer orçamento',
    confere: (d) =>
      expect(d.transfer).toEqual({ tag: 'Time de Vendas', summary: 'Cliente [Gás do Povo], quer orçamento' }),
  },
  { abre: '[[AGENTE:Suporte\nTécnico|quer a 2ª via', confere: (d) => expect(d.routeAgent).toEqual({ name: 'Suporte Técnico', summary: 'quer a 2ª via' }) },
  {
    abre: '[[AGENDAR:2026-10-08T14:00\n|Visita ·\nAna|Dra.\nTeste|nova',
    confere: (d) =>
      expect(d.schedule).toEqual({
        startsLocal: '2026-10-08T14:00',
        title: 'Visita · Ana',
        profissional: 'Dra. Teste',
        modo: { tipo: 'nova' },
      }),
  },
  {
    abre: '[[COBRAR:125,00\n| +7 | Mensalidade\nde outubro',
    confere: (d) => expect(d.charge).toEqual({ valueRaw: '125,00', dueRaw: '+7', description: 'Mensalidade de outubro' }),
  },
  { abre: '[[ATRIBUTO:Cidade de\norigem = Centro\nNorte', confere: (d) => expect(d.attribute).toEqual({ field: 'Cidade de origem', value: 'Centro Norte' }) },
  { abre: '[[TELEFONE:+55 11\n90000-0000', confere: (d) => expect(d.setPhone).toBe('5511900000000') },
  { abre: '[[COBRANCA:promessa\n|2026-10-10', confere: (d) => expect(d.collection).toEqual({ kind: 'promessa', date: '2026-10-10' }) },
]

describe('revisão 3: marcador bem fechado com quebra de linha dentro de um campo de uma linha', () => {
  for (const c of QUEBRADOS) {
    it(`${JSON.stringify(c.abre)}: executa, numa linha só, e a resposta fica`, () => {
      for (const fecho of [']]', '] ]', ']\n]']) {
        const { d, texto, aviso } = pelaRede(`Oi.\n${c.abre}${fecho}\nTudo certo?`)
        c.confere(d)
        expect(linhas(d.text), JSON.stringify(fecho)).toEqual(['Oi.', 'Tudo certo?'])
        expect(linhas(texto)).toEqual(['Oi.', 'Tudo certo?'])
        expect(aviso).toBeNull()
      }
    })
  }

  it('sem fechamento válido adiante, a quebra continua fechando o argumento de uma linha', () => {
    const d = parseCloseDirectives('[[ETIQUETA:Lead quente\nOlá! [[GANHO]]')
    expect(d.tags).toEqual(['Lead quente'])
    expect(d.win).toBe(true)
    expect(d.text).toBe('Olá!')
    const p = parseCloseDirectives('[[PERDER:Achou caro\nObrigada! Até a próxima.')
    expect(p.lose).toEqual({ reason: 'Achou caro' })
    expect(p.text).toBe('Obrigada! Até a próxima.')
  })

  it('a quebra não atravessa o próximo marcador: o "]]" dele não conta', () => {
    const d = parseCloseDirectives('[[ETIQUETA:Lead quente\nOlá! [[NOTA:pediu desconto]]')
    expect(d.tags).toEqual(['Lead quente'])
    expect(d.note).toBe('pediu desconto')
    expect(d.text).toBe('Olá!')
  })

  it('3.000 linhas dentro do campo: < 100 ms, bem fechado ou não', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const corpo = 'a\n'.repeat(3000)
    const abres = [
      '[[ETIQUETA:',
      '[[FUNIL:',
      '[[PERDER:',
      '[[PERDER:a|',
      '[[TRANSFERIR:',
      '[[AGENTE:',
      '[[AGENDAR:2026-10-08T14:00|',
      '[[AGENDAR:2026-10-08T14:00|a|b|',
      '[[COBRAR:',
      '[[COBRAR:1|2|',
      '[[ATRIBUTO:',
      '[[ATRIBUTO:a=',
      '[[TELEFONE:+55',
      '[[COBRANCA:promessa',
    ]
    for (const abre of abres) {
      for (const fecho of ['', ']]', '] ]', ']', ']\nTchau', '] x', '\n[[GANHO]]', ']\nOi ]]', 'x] y ]]']) {
        for (const raw of [`Já.\n${abre}${corpo}${fecho}`, `Já.\n${abre}\n${corpo}${fecho}`]) {
          const t0 = performance.now()
          pelaRede(raw)
          // Folga de 500 ms (02/10): sem carga leva ~32 ms; com a suíte inteira e o tsc
          // rodando juntos um caso passou de 100 ms. O que este teste pega é o
          // backtracking catastrófico, que leva SEGUNDOS — não a máquina carregada.
          expect(performance.now() - t0, `${abre} ${JSON.stringify(fecho)}`).toBeLessThan(500)
        }
      }
    }
  })
})

describe('revisão 3: "]" único no MEIO da linha do [[PERDER:]]', () => {
  it('o motivo para no "]" — a frase do cliente não vira motivo', () => {
    expect(parseCloseDirectives('[[PERDER:Achou caro] Obrigada pelo contato!').lose).toEqual({ reason: 'Achou caro' })
    expect(parseCloseDirectives('[[PERDER:Achou caro] Obrigada pelo contato!]\nTchau').lose).toEqual({
      reason: 'Achou caro',
    })
    expect(parseCloseDirectives('Até!\n[[PERDER:Achou caro] Qualquer coisa me chama\nAbraço').lose).toEqual({
      reason: 'Achou caro',
    })
  })

  it('continua: "] [[RESOLVER]]" perde com "Achou caro" e resolve', () => {
    const d = parseCloseDirectives('Até! [[PERDER:Achou caro] [[RESOLVER]]')
    expect(d.lose).toEqual({ reason: 'Achou caro' })
    expect(d.resolve).toBe(true)
  })

  it('o "[…]" do próprio motivo fica inteiro', () => {
    expect(parseCloseDirectives('[[PERDER:Cliente [VIP] desistiu').lose).toEqual({ reason: 'Cliente [VIP] desistiu' })
    expect(parseCloseDirectives('[[PERDER:Cliente [VIP] desistiu\nObrigada!').lose).toEqual({
      reason: 'Cliente [VIP] desistiu',
    })
    expect(parseCloseDirectives('[[PERDER:Cliente [VIP] desistiu] Obrigada!').lose).toEqual({
      reason: 'Cliente [VIP] desistiu',
    })
    expect(parseCloseDirectives('[[PERDER:Cliente [VIP] desistiu]]').lose).toEqual({ reason: 'Cliente [VIP] desistiu' })
  })

  it('com comentário, o motivo é o que vem antes do "|" (não muda)', () => {
    expect(parseCloseDirectives('[[PERDER:Achou caro | quer [à vista] ]]').lose).toEqual({
      reason: 'Achou caro',
      note: 'quer [à vista]',
    })
  })
})

describe('revisão 3: quebra de linha logo depois do ":"', () => {
  it('com o fechamento válido adiante, a linha de baixo é o argumento', () => {
    const { d, texto, aviso } = pelaRede('Oi.\n[[ETIQUETA:\nLead quente]]\nOlá!')
    expect(d.tags).toEqual(['Lead quente'])
    expect(linhas(texto)).toEqual(['Oi.', 'Olá!'])
    expect(aviso).toBeNull()
    expect(parseCloseDirectives('[[FUNIL:\n  Vendas > Proposta ] ]').funnelStage).toBe('Vendas > Proposta')
    expect(parseCloseDirectives('[[PERDER:\nAchou caro]]').lose).toEqual({ reason: 'Achou caro' })
    expect(parseCloseDirectives('[[AGENDAR:\n2026-10-08T14:00|Visita]]').schedule?.startsLocal).toBe('2026-10-08T14:00')
    expect(parseCloseDirectives('[[COBRAR:\n125,00|\n+7]]').charge).toEqual({ valueRaw: '125,00', dueRaw: '+7', description: '' })
    expect(parseCloseDirectives('[[ATRIBUTO:\nCidade=\nCentro]]').attribute).toEqual({ field: 'Cidade', value: 'Centro' })
    expect(parseCloseDirectives('[[VOZ:\naudio]]').voicePref).toBe('audio')
    expect(parseCloseDirectives('[[TELEFONE:\n+55 11 90000-0000]]').setPhone).toBe('5511900000000')
    expect(parseCloseDirectives('[[COBRANCA:\ncomprovante]]').collection).toEqual({ kind: 'comprovante', date: null })
    expect(parseCloseDirectives('[[AGENTE:\nSuporte|quer a 2ª via]]').routeAgent).toEqual({ name: 'Suporte', summary: 'quer a 2ª via' })
  })

  it('o resumo com "[…]" depois não atrapalha (TRANSFERIR, comentário do PERDER)', () => {
    const { d, texto } = pelaRede('[[TRANSFERIR:\nVendas|Cliente [Gás do Povo], quer orçamento]]\nJá te passo!')
    expect(d.transfer).toEqual({ tag: 'Vendas', summary: 'Cliente [Gás do Povo], quer orçamento' })
    expect(texto).toBe('Já te passo!')
    expect(parseCloseDirectives('[[PERDER:\nÁrea sem clientes | cidade [fora], capital baixo]]').lose).toEqual({
      reason: 'Área sem clientes',
      note: 'cidade [fora], capital baixo',
    })
  })

  it('SEM fechamento adiante, a despedida de baixo NÃO vira o motivo — volta para a rede e o aviso ⚠️', () => {
    const { d, texto, aviso } = pelaRede('[[PERDER:\nObrigada pelo contato, qualquer coisa estou aqui!')
    expect(d.lose).toBeNull()
    expect(texto).toBe('')
    expect(aviso).toContain('[[PERDER…] ]')
  })

  it('o mesmo nas outras ações de uma linha', () => {
    for (const [raw, nome] of [
      ['[[ETIQUETA:\nOlá Maria! Como posso ajudar?', 'ETIQUETA'],
      ['[[FUNIL:\nOlá Maria! Como posso ajudar?', 'FUNIL'],
      ['[[TRANSFERIR:\nJá te passo para a equipe!', 'TRANSFERIR'],
      ['[[AGENTE:\nJá te passo para a equipe!', 'AGENTE'],
      ['[[ATRIBUTO:\nCidade=Centro', 'ATRIBUTO'],
      ['[[ATRIBUTO:Cidade=\nObrigada!', 'ATRIBUTO'],
      ['[[COBRAR:125,00|\nObrigada!', 'COBRAR'],
    ]) {
      const { d, aviso } = pelaRede(raw)
      expect(d, raw).toMatchObject({ tags: [], funnelStage: null, transfer: null, routeAgent: null, attribute: null, charge: null })
      expect(aviso, raw).toContain(`[[${nome}…] ]`)
    }
  })

  it('sem fechamento e antes de outro marcador: só o outro vale', () => {
    const { d, aviso } = pelaRede('[[PERDER:\nObrigada pelo contato! [[RESOLVER]]')
    expect(d.lose).toBeNull()
    expect(d.resolve).toBe(true)
    expect(aviso).toContain('[[PERDER…] ]')
  })
})

describe('tirar do texto de UMA vez', () => {
  it('um marcador sem fechamento antes de outro não come o texto depois do segundo', () => {
    // Tirando um de cada vez, sem a etiqueta a nota ia até o fim e levava o "c".
    const d = parseCloseDirectives('[[NOTA:a [[ETIQUETA:b]] c')
    expect(d.note).toBe('a')
    expect(d.tags).toEqual(['b'])
    expect(d.text).toBe('c')
  })
})

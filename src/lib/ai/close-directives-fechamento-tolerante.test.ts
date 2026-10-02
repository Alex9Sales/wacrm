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
            expect(performance.now() - t0, JSON.stringify(fecho)).toBeLessThan(100)
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

describe('tirar do texto de UMA vez', () => {
  it('um marcador sem fechamento antes de outro não come o texto depois do segundo', () => {
    // Tirando um de cada vez, sem a etiqueta a nota ia até o fim e levava o "c".
    const d = parseCloseDirectives('[[NOTA:a [[ETIQUETA:b]] c')
    expect(d.note).toBe('a')
    expect(d.tags).toEqual(['b'])
    expect(d.text).toBe('c')
  })
})

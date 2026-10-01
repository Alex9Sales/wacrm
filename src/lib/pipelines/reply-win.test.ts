import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SQL } from 'drizzle-orm'

// 🏆 "Respondeu = ganho" (Zelo, reunião de 29/09): o pré-vendas ganha quando o
// lead RESPONDE, na etapa em que o card está (mede em que tentativa converteu),
// e nasce o card no comercial ligado à mesma conversa.
//
// O db é trocado por respostas por TABELA; o WHERE é renderizado pelo dialeto
// do Postgres pra saber de qual funil é a consulta e conferir os parâmetros
// dos UPDATEs (card ligado à conversa, tarefas movidas).

const PRE = '11111111-1111-4111-8111-111111111111' // "1. Cadência pré-vendas"
const COM = '22222222-2222-4222-8222-222222222222' // "2. Comercial | Franquia"
const QUALIF = '33333333-3333-4333-8333-333333333333' // etapa "Qualificação"
const POS = '44444444-4444-4444-8444-444444444444' // um 3º funil (cadeia)
const POS_STAGE = '55555555-5555-4555-8555-555555555555'

type Row = { id: string; conversationId: string | null; createdAt: string | null; pipelineName: string }

const h = vi.hoisted(() => ({
  /** Cards ABERTOS do contato, por funil de origem. */
  candidates: {} as Record<string, Row[]>,
  /** Destino por etapa (null = funil/etapa não existe). */
  targets: {} as Record<string, { pipelineName: string; stageName: string } | null>,
  movedTaskIds: [] as string[],
  selects: [] as { table: string; params: unknown[] }[],
  updates: [] as { table: string; set: Record<string, unknown>; sql: string; params: unknown[] }[],
  won: vi.fn(),
  spawn: vi.fn(),
  note: vi.fn(),
  publish: vi.fn(),
  settings: vi.fn(),
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const { PgDialect: Dialect } = await import('drizzle-orm/pg-core')
  const dialect = new Dialect()
  const nameOf = (t: unknown) =>
    t === actual.deals ? 'deals' : t === actual.tasks ? 'tasks' : t === actual.pipelineStages ? 'pipeline_stages' : '?'
  const db = {
    select: () => ({
      from: (table: unknown) => {
        let params: unknown[] = []
        const chain = {
          innerJoin: () => chain,
          where: (w: SQL) => {
            params = dialect.sqlToQuery(w).params
            return chain
          },
          orderBy: () => chain,
          limit: async () => {
            h.selects.push({ table: nameOf(table), params })
            if (table === actual.deals) {
              const pipe = Object.keys(h.candidates).find((p) => params.includes(p))
              return pipe ? h.candidates[pipe] : []
            }
            if (table === actual.pipelineStages) {
              const stage = Object.keys(h.targets).find((s) => params.includes(s))
              const t = stage ? h.targets[stage] : null
              return t ? [t] : []
            }
            return []
          },
        }
        return chain
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (w: SQL) => {
          const q = dialect.sqlToQuery(w)
          h.updates.push({ table: nameOf(table), set, sql: q.sql, params: q.params })
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => (table === actual.tasks ? h.movedTaskIds.map((id) => ({ id })) : []),
          })
        },
      }),
    }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/ai/close-actions', () => ({
  markDealWonInPlace: (...a: unknown[]) => h.won(...a),
  postInternalNote: (...a: unknown[]) => h.note(...a),
}))
vi.mock('./cross-funnel', () => ({ spawnDealInFunnel: (...a: unknown[]) => h.spawn(...a) }))
vi.mock('@/lib/events/publish', () => ({ publishEvent: (...a: unknown[]) => h.publish(...a) }))
vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: (...a: unknown[]) => h.settings(...a),
}))
// Sem Redis no teste: claimOnce devolve undefined (= avisa).
vi.mock('@/lib/ai/reply-marker', () => ({ claimOnce: async () => undefined }))

import {
  isLeadReply,
  looksLikeAutoReply,
  maybeWinOnReply,
  normalizeReplyWinRules,
  pickReplyWinDeal,
  replyWinNote,
} from './reply-win'

const input = {
  accountId: 'acc',
  contactId: 'c1',
  conversationId: 'conv-wa',
  actorUserId: 'u-dono',
  contentText: 'Oi, tenho interesse sim',
  interactiveReplyId: null,
}

const rule = { fromPipelineId: PRE, toPipelineId: COM, toStageId: QUALIF }

const card = (over: Partial<Row> = {}): Row => ({
  id: 'd-pre',
  conversationId: null,
  createdAt: '2026-09-29T12:00:00Z',
  pipelineName: '1. Cadência pré-vendas',
  ...over,
})

beforeEach(() => {
  h.candidates = {}
  h.targets = { [QUALIF]: { pipelineName: '2. Comercial | Franquia', stageName: 'Qualificação' } }
  h.movedTaskIds = []
  h.selects = []
  h.updates = []
  h.settings.mockResolvedValue({ replyWinRules: [rule] })
  h.won.mockImplementation(async (a: { dealId: string }) => ({ dealId: a.dealId, stageName: 'Sem contato' }))
  h.spawn.mockResolvedValue({ dealId: 'd-com', created: true })
  h.note.mockResolvedValue(true)
  h.publish.mockResolvedValue(undefined)
})

describe('normalizeReplyWinRules — regra gravada à mão por SQL', () => {
  it('não-lista ou lixo = nenhuma regra', () => {
    expect(normalizeReplyWinRules(undefined)).toEqual([])
    expect(normalizeReplyWinRules({ fromPipelineId: PRE })).toEqual([])
    expect(normalizeReplyWinRules([null, 'x', 1])).toEqual([])
  })

  it('descarta id que não é uuid (o Postgres lançaria a cada mensagem)', () => {
    expect(normalizeReplyWinRules([{ ...rule, toStageId: 'qualificacao' }])).toEqual([])
    expect(normalizeReplyWinRules([{ ...rule, toPipelineId: undefined }])).toEqual([])
  })

  it('funil para ele mesmo não vale (ganharia o card recém-aberto)', () => {
    expect(normalizeReplyWinRules([{ fromPipelineId: PRE, toPipelineId: PRE, toStageId: QUALIF }])).toEqual([])
  })

  it('origem repetida: a primeira vence', () => {
    const r = normalizeReplyWinRules([rule, { fromPipelineId: PRE, toPipelineId: POS, toStageId: POS_STAGE }])
    expect(r).toEqual([rule])
  })
})

describe('isLeadReply — o que conta como resposta', () => {
  it('texto, mídia rotulada e clique em botão contam', () => {
    expect(isLeadReply('Oi')).toBe(true)
    expect(isLeadReply('[audio]')).toBe(true)
    expect(isLeadReply('', 'btn_quero_saber_mais')).toBe(true)
    expect(isLeadReply(null, 'btn_quero_saber_mais')).toBe(true)
    // enquete/edição/visualização única: gente de verdade
    expect(isLeadReply('[Mensagem não suportada pela API oficial do WhatsApp (enquete, edição ou mídia de visualização única)]')).toBe(true)
  })

  it('descadastro não é conversão', () => {
    expect(isLeadReply('SAIR')).toBe(false)
    expect(isLeadReply('não quero mais')).toBe(false)
    expect(isLeadReply('Não quero mais', 'optout_stop')).toBe(false)
  })

  it('registro de sistema não é o lead falando', () => {
    expect(isLeadReply('⁣call⁣missed')).toBe(false)
    expect(isLeadReply('⁣callperm⁣1:p:0')).toBe(false)
    expect(isLeadReply('[Tipo de mensagem não suportado: system]')).toBe(false)
  })

  it('vazio sem clique não conta', () => {
    expect(isLeadReply(null)).toBe(false)
    expect(isLeadReply('   ')).toBe(false)
    expect(isLeadReply('', '  ')).toBe(false)
  })

  // Revisão 01/10: ganho no RD não volta — robô do lado do lead não converte.
  it('resposta automática (ausência, fora do escritório) não conta', () => {
    expect(isLeadReply('Olá! Agradecemos o seu contato. Retornaremos o mais breve possível.')).toBe(false)
    expect(isLeadReply('Esta é uma mensagem automática.')).toBe(false)
    expect(isLeadReply('Resposta automática: estou fora do escritório até segunda.')).toBe(false)
    expect(isLeadReply('No momento não podemos atender. Estamos fora do horário de atendimento.')).toBe(false)
    expect(isLeadReply('Automatic reply: Out of office')).toBe(false)
  })

  it('gente de verdade passa, inclusive agradecendo', () => {
    expect(looksLikeAutoReply('Oi, tenho interesse sim')).toBe(false)
    expect(looksLikeAutoReply('Obrigada pelo contato! Quero saber mais')).toBe(false)
    expect(looksLikeAutoReply('B e C')).toBe(false)
    expect(looksLikeAutoReply('No momento estou trabalhando, te respondo à noite')).toBe(false)
    // Uma frase "de robô" sozinha não basta: gente também escreve assim.
    expect(looksLikeAutoReply('No momento não podemos investir, obrigado')).toBe(false)
    expect(looksLikeAutoReply('Agradecemos o contato, mas não temos interesse')).toBe(false)
    expect(looksLikeAutoReply('Vou ver com meu sócio e retornaremos em breve')).toBe(false)
    expect(isLeadReply('Agradecemos o contato', 'btn_quero_saber_mais')).toBe(true) // clique conta
  })
})

describe('pickReplyWinDeal', () => {
  it('prefere o card ligado a esta conversa, mesmo mais antigo', () => {
    const r = pickReplyWinDeal(
      [
        card({ id: 'novo', createdAt: '2026-09-30T10:00:00Z', conversationId: 'conv-email' }),
        card({ id: 'ligado', createdAt: '2026-09-01T10:00:00Z', conversationId: 'conv-wa' }),
      ],
      'conv-wa',
    )
    expect(r?.id).toBe('ligado')
  })

  it('sem card ligado: o mais recente — e sem data vai pro fim (DESC do Postgres poria no topo)', () => {
    const r = pickReplyWinDeal(
      [card({ id: 'sem-data', createdAt: null }), card({ id: 'velho', createdAt: '2026-09-01T00:00:00Z' }), card({ id: 'recente', createdAt: '2026-09-28T00:00:00Z' })],
      'conv-wa',
    )
    expect(r?.id).toBe('recente')
  })

  it('pula o que a mesma mensagem acabou de abrir; lista vazia = null', () => {
    expect(pickReplyWinDeal([card({ id: 'a' })], 'conv-wa', new Set(['a']))).toBeNull()
    expect(pickReplyWinDeal([], 'conv-wa')).toBeNull()
  })
})

describe('replyWinNote', () => {
  const base = {
    fromPipelineName: '1. Cadência pré-vendas',
    wonStageName: 'Sem contato',
    toPipelineName: '2. Comercial | Franquia',
    toStageName: 'Qualificação',
  }

  it('card novo, com nomes reais de funil/etapa', () => {
    expect(replyWinNote({ ...base, spawned: { created: true }, movedTasks: 0 })).toBe(
      '🏆 O lead respondeu: card de «1. Cadência pré-vendas» ganho na etapa «Sem contato» e card aberto em «2. Comercial | Franquia › Qualificação».',
    )
  })

  it('card reaproveitado e tarefas movidas aparecem', () => {
    const t = replyWinNote({ ...base, spawned: { created: false }, movedTasks: 2 })
    expect(t).toContain('já tinha aberto em «2. Comercial | Franquia»')
    expect(t).toContain('2 tarefas abertas passaram')
    expect(replyWinNote({ ...base, spawned: { created: true }, movedTasks: 1 })).toContain('1 tarefa aberta passou')
  })

  it('destino que não saiu é dito com todas as letras', () => {
    expect(replyWinNote({ ...base, spawned: null, movedTasks: 0 })).toContain('NÃO foi aberto')
  })
})

describe('maybeWinOnReply', () => {
  it('conta sem regra: não consulta card nem ganha nada', async () => {
    h.settings.mockResolvedValue({ replyWinRules: [] })
    h.candidates = { [PRE]: [card()] }
    await maybeWinOnReply(input)
    expect(h.selects).toEqual([])
    expect(h.won).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('descadastro: nada — nem lê os ajustes', async () => {
    h.candidates = { [PRE]: [card()] }
    await maybeWinOnReply({ ...input, contentText: 'PARAR' })
    expect(h.settings).not.toHaveBeenCalled()
    expect(h.won).not.toHaveBeenCalled()
  })

  it('marcador de sistema (registro de ligação): nada', async () => {
    h.candidates = { [PRE]: [card()] }
    await maybeWinOnReply({ ...input, contentText: '⁣call⁣answered:42' })
    expect(h.won).not.toHaveBeenCalled()
    expect(h.note).not.toHaveBeenCalled()
  })

  it('contato sem card aberto no funil de origem: nada', async () => {
    await maybeWinOnReply(input)
    expect(h.selects).toHaveLength(1)
    expect(h.selects[0].params).toEqual(['acc', 'c1', PRE, 'open'])
    expect(h.won).not.toHaveBeenCalled()
  })

  it('card do contato no funil de origem: ganha em pé, abre no destino, liga a conversa, move as tarefas e avisa', async () => {
    h.candidates = { [PRE]: [card()] }
    h.movedTaskIds = ['t1', 't2']
    await maybeWinOnReply(input)

    // Sem conversationId: a nota genérica do markDealWonInPlace não sai repetida.
    expect(h.won).toHaveBeenCalledWith({
      accountId: 'acc',
      userId: 'u-dono',
      dealId: 'd-pre',
      by: 'system',
      skipAccountAutomation: true,
    })
    expect(h.spawn).toHaveBeenCalledWith({
      accountId: 'acc',
      userId: 'u-dono',
      sourceDealId: 'd-pre',
      pipelineId: COM,
      stageId: QUALIF,
      kind: 'won',
      by: 'system',
    })

    const link = h.updates.find((u) => u.table === 'deals')
    expect(link?.set).toEqual({ conversationId: 'conv-wa' })
    expect(link?.params).toEqual(['d-com', 'acc'])
    expect(link?.sql).toContain('"conversation_id" is null')

    const moved = h.updates.find((u) => u.table === 'tasks')
    expect(moved?.set.dealId).toBe('d-com')
    expect(moved?.params).toEqual(['acc', 'd-pre', 'open'])

    expect(h.note).toHaveBeenCalledTimes(1)
    expect(h.note.mock.calls[0][0]).toEqual({
      conversationId: 'conv-wa',
      text: '🏆 O lead respondeu: card de «1. Cadência pré-vendas» ganho na etapa «Sem contato» e card aberto em «2. Comercial | Franquia › Qualificação». 2 tarefas abertas passaram para esse card.',
    })
    expect(h.publish).toHaveBeenCalledWith('acc', { type: 'message.received', conversationId: 'conv-wa', fromMe: true })
  })

  it('clique em botão do modelo sem texto também ganha', async () => {
    h.candidates = { [PRE]: [card()] }
    await maybeWinOnReply({ ...input, contentText: '', interactiveReplyId: 'btn_tenho_interesse' })
    expect(h.won).toHaveBeenCalledTimes(1)
    expect(h.spawn).toHaveBeenCalledTimes(1)
  })

  it('markDealWonInPlace devolve null (outra mensagem ganhou primeiro): não cria card nem mexe em nada', async () => {
    h.candidates = { [PRE]: [card()] }
    h.won.mockResolvedValue(null)
    await maybeWinOnReply(input)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
    expect(h.note).not.toHaveBeenCalled()
  })

  it('prefere o card ligado a esta conversa ao mais recente do contato', async () => {
    h.candidates = {
      [PRE]: [
        card({ id: 'd-recente', createdAt: '2026-09-30T10:00:00Z', conversationId: null }),
        card({ id: 'd-ligado', createdAt: '2026-09-20T10:00:00Z', conversationId: 'conv-wa' }),
      ],
    }
    await maybeWinOnReply(input)
    expect(h.won).toHaveBeenCalledWith(expect.objectContaining({ dealId: 'd-ligado' }))
    expect(h.spawn).toHaveBeenCalledWith(expect.objectContaining({ sourceDealId: 'd-ligado' }))
  })

  it('destino inexistente: NÃO ganha (lead ficaria sem card aberto) e avisa a equipe', async () => {
    h.candidates = { [PRE]: [card()] }
    h.targets = {}
    await maybeWinOnReply(input)
    expect(h.won).not.toHaveBeenCalled()
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.note.mock.calls[0][0].text).toContain('não existe mais')
    expect(h.note.mock.calls[0][0].text).toContain('«1. Cadência pré-vendas»')
  })

  it('card de destino não saiu: avisa e não move tarefas para lugar nenhum', async () => {
    h.candidates = { [PRE]: [card()] }
    h.spawn.mockResolvedValue(null)
    await maybeWinOnReply(input)
    expect(h.updates).toEqual([])
    expect(h.note.mock.calls[0][0].text).toContain('NÃO foi aberto')
  })

  it('card reaproveitado no destino: não diz que abriu card novo', async () => {
    h.candidates = { [PRE]: [card()] }
    h.spawn.mockResolvedValue({ dealId: 'd-com-antigo', created: false })
    await maybeWinOnReply(input)
    expect(h.updates.find((u) => u.table === 'deals')?.params).toEqual(['d-com-antigo', 'acc'])
    expect(h.note.mock.calls[0][0].text).toContain('já tinha aberto')
  })

  it('regras em cadeia: o card que esta mensagem abriu não é ganho em cascata', async () => {
    h.settings.mockResolvedValue({
      replyWinRules: [rule, { fromPipelineId: COM, toPipelineId: POS, toStageId: POS_STAGE }],
    })
    h.targets[POS_STAGE] = { pipelineName: 'Pós-venda', stageName: 'Boas-vindas' }
    // O select do 2º funil "enxerga" o card que a 1ª regra acabou de abrir.
    h.candidates = { [PRE]: [card()], [COM]: [card({ id: 'd-com', pipelineName: '2. Comercial | Franquia' })] }
    await maybeWinOnReply(input)
    expect(h.won).toHaveBeenCalledTimes(1)
    expect(h.won).toHaveBeenCalledWith(expect.objectContaining({ dealId: 'd-pre' }))
  })

  it('nunca lança: ajustes ilegíveis viram log', async () => {
    h.settings.mockRejectedValue(new Error('db caiu'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(maybeWinOnReply(input)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('nunca lança: erro no meio de uma regra não derruba a próxima', async () => {
    h.settings.mockResolvedValue({
      replyWinRules: [rule, { fromPipelineId: POS, toPipelineId: COM, toStageId: QUALIF }],
    })
    h.candidates = { [PRE]: [card()], [POS]: [card({ id: 'd-pos', pipelineName: 'Pós-venda' })] }
    h.won.mockRejectedValueOnce(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(maybeWinOnReply(input)).resolves.toBeUndefined()
    expect(h.won).toHaveBeenCalledTimes(2)
    expect(h.won.mock.calls[1][0]).toEqual(expect.objectContaining({ dealId: 'd-pos' }))
    spy.mockRestore()
  })
})

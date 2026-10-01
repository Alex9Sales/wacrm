import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 01/10 (Zelo): [[PERDER:motivo | comentário]] + perda/ganho ATÔMICOS. Banco,
// configurações da conta e o funil→funil trocados por stubs; o WHERE do UPDATE
// é renderizado pelo dialeto do Drizzle pra provar que confere status='open'.
const h = vi.hoisted(() => ({
  /** Card aberto que o SELECT acha (null = nenhum). */
  openDeal: null as { id: string; stageId: string; pipelineId: string } | null,
  /** Etapas do funil do card (loadDealCloseContext) — id + nome. */
  stages: [] as { id: string; name: string }[],
  /** Nome da etapa do card (lookup por id em markDeal*InPlace). */
  stageName: 'Qualificado' as string | null,
  /** Funis da conta pro [[FUNIL:<funil> > <etapa>]]. */
  funnels: [] as { pipelineId: string; pipelineName: string; stageId: string; stageName: string }[],
  /** O que o UPDATE … RETURNING devolve ([] = outra mensagem fechou antes). */
  updateReturns: [{ id: 'deal-1' }] as { id: string }[],
  updates: [] as { values: Record<string, unknown>; where: SQL }[],
  inserts: [] as { table: string; values: Record<string, unknown> }[],
  settings: { lostReasons: [] as string[], lostReasonsLocked: false },
  settingsThrows: false,
  settingsCalls: 0,
  crossFunnel: [] as unknown[][],
  spawned: [] as unknown[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const tableName = (t: unknown) =>
    t === actual.deals
      ? 'deals'
      : t === actual.dealEvents
        ? 'deal_events'
        : t === actual.messages
          ? 'messages'
          : t === actual.pipelineStages
            ? 'pipeline_stages'
            : t === actual.pipelines
              ? 'pipelines'
              : '?'
  const rowsFor = (table: string, fields: Record<string, unknown>) => {
    if (table === 'deals') return h.openDeal ? [h.openDeal] : []
    if (table === 'pipelines') return h.funnels
    if (table === 'pipeline_stages') {
      // Com "id" no select = a lista do funil; só "name" = lookup da etapa do card.
      if ('id' in fields) return h.stages
      return h.stageName ? [{ name: h.stageName }] : []
    }
    return []
  }
  // Cadeia do select: qualquer método devolve a própria cadeia; o await
  // resolve as linhas da tabela.
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) c[m] = () => c
    c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(ok, ko)
    return c
  }
  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      h.inserts.push({ table: tableName(table), values })
      return Promise.resolve()
    },
  })
  const update = () => ({
    set: (values: Record<string, unknown>) => ({
      where: (where: SQL) => ({
        returning: async () => {
          h.updates.push({ values, where })
          return h.updateReturns
        },
      }),
    }),
  })
  const db = {
    select: (fields: Record<string, unknown>) => ({
      from: (table: unknown) => chain(() => rowsFor(tableName(table), fields)),
    }),
    insert,
    update,
    transaction: async <T>(fn: (tx: { insert: typeof insert; update: typeof update }) => Promise<T>) =>
      fn({ insert, update }),
  }
  return { ...actual, db }
})

vi.mock('@/lib/settings/account-settings', () => ({
  getAccountSettings: async () => {
    h.settingsCalls++
    if (h.settingsThrows) throw new Error('banco fora')
    return h.settings
  },
}))

vi.mock('@/lib/pipelines/cross-funnel', () => ({
  maybeSpawnCrossFunnelDeal: async (...a: unknown[]) => {
    h.crossFunnel.push(a)
  },
  spawnDealInFunnel: async (input: unknown) => {
    h.spawned.push(input)
    return { dealId: 'deal-novo', created: true }
  },
}))

import {
  applyCloseActions,
  loadDealCloseContext,
  lostInternalNoteText,
  markDealLostInPlace,
  markDealWonInPlace,
  resolveAiLostReason,
} from './close-actions'

const dialect = new PgDialect()
const whereSql = (w: SQL) => dialect.sqlToQuery(w)
const events = () => h.inserts.filter((i) => i.table === 'deal_events')
const notes = () => h.inserts.filter((i) => i.table === 'messages')

beforeEach(() => {
  h.openDeal = { id: 'deal-1', stageId: 'st-2', pipelineId: 'pipe-1' }
  h.stages = [
    { id: 'st-1', name: 'Novo lead' },
    { id: 'st-2', name: 'Qualificado' },
    { id: 'st-3', name: 'Reunião agendada' },
  ]
  h.stageName = 'Qualificado'
  h.funnels = []
  h.updateReturns = [{ id: 'deal-1' }]
  h.updates = []
  h.inserts = []
  h.settings = { lostReasons: ['Achou caro', 'Área sem clientes', 'Não responde'], lostReasonsLocked: false }
  h.settingsThrows = false
  h.settingsCalls = 0
  h.crossFunnel = []
  h.spawned = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('resolveAiLostReason — motivo da IA × lista da conta', () => {
  const lista = ['Achou caro', 'Área sem clientes', 'Outros']

  it('casou sem caixa/acento → grafia DA LISTA, comentário intacto', () => {
    expect(
      resolveAiLostReason({ reason: 'area SEM clientes', note: 'cidade X', lostReasons: lista, locked: true }),
    ).toEqual({ reason: 'Área sem clientes', note: 'cidade X' })
  })

  it('lista TRAVADA e motivo fora dela → "Outros" e o texto da IA abre o comentário', () => {
    expect(
      resolveAiLostReason({ reason: 'Mudou de cidade', note: 'volta em 2027', lostReasons: lista, locked: true }),
    ).toEqual({ reason: 'Outros', note: 'Mudou de cidade — volta em 2027' })
    expect(resolveAiLostReason({ reason: 'Mudou de cidade', lostReasons: lista, locked: true })).toEqual({
      reason: 'Outros',
      note: 'Mudou de cidade',
    })
  })

  it('a gaveta usa a grafia da lista ("Outro") e cai em "Outros" quando a lista não tem', () => {
    expect(resolveAiLostReason({ reason: 'x', lostReasons: ['Achou caro', 'outro'], locked: true }).reason).toBe('outro')
    expect(resolveAiLostReason({ reason: 'x', lostReasons: ['Achou caro'], locked: true }).reason).toBe('Outros')
  })

  it('a IA já disse "Outros" e a lista não tem a gaveta → não repete no comentário', () => {
    expect(resolveAiLostReason({ reason: 'outros', note: 'n', lostReasons: ['Achou caro'], locked: true })).toEqual({
      reason: 'Outros',
      note: 'n',
    })
  })

  it('lista ABERTA e motivo fora dela → fica como a IA escreveu', () => {
    expect(
      resolveAiLostReason({ reason: 'Mudou de cidade', note: '  ', lostReasons: lista, locked: false }),
    ).toEqual({ reason: 'Mudou de cidade', note: null })
  })
})

describe('lostInternalNoteText', () => {
  it('sem comentário = a nota de sempre', () => {
    expect(lostInternalNoteText({ stageName: 'Qualificado', reason: 'Achou caro', by: 'ai' })).toBe(
      '🔻 Negócio marcado como PERDIDO na etapa "Qualificado" — motivo: Achou caro. (IA)',
    )
    expect(
      lostInternalNoteText({ stageName: null, followUps: 3, reason: 'Não respondeu (3 follow-ups)', by: 'followup' }),
    ).toBe('🔻 Negócio marcado como PERDIDO após 3 follow-up(s) sem retorno — motivo: Não respondeu (3 follow-ups). (followup)')
  })

  it('com comentário: linha própria depois do motivo', () => {
    expect(
      lostInternalNoteText({ stageName: 'Novo lead', reason: 'Área sem clientes', note: 'cidade X · capital Y', by: 'ai' }),
    ).toBe('🔻 Negócio marcado como PERDIDO na etapa "Novo lead" — motivo: Área sem clientes. (IA)\n💬 cidade X · capital Y')
  })
})

describe('markDealLostInPlace', () => {
  it('perde com o motivo DA LISTA + comentário no evento e na nota interna', async () => {
    const r = await markDealLostInPlace({
      accountId: 'acc',
      userId: 'u1',
      conversationId: 'conv-1',
      reason: 'área sem clientes',
      note: 'Lead fora da área — cidade de interesse: Cidade X/UF',
      by: 'ai',
    })
    expect(r).toEqual({ dealId: 'deal-1', stageName: 'Qualificado' })
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0].values).toEqual({ status: 'lost', lostReason: 'Área sem clientes' })
    expect(events()).toHaveLength(1)
    expect(events()[0].values.data).toMatchObject({
      from: 'open',
      to: 'lost',
      reason: 'Área sem clientes',
      note: 'Lead fora da área — cidade de interesse: Cidade X/UF',
      stageName: 'Qualificado',
      by: 'ai',
    })
    expect(notes()).toHaveLength(1)
    expect(String(notes()[0].values.contentText)).toContain('motivo: Área sem clientes.')
    expect(String(notes()[0].values.contentText)).toContain('\n💬 Lead fora da área — cidade de interesse: Cidade X/UF')
    expect(h.crossFunnel).toEqual([['acc', 'u1', 'deal-1', 'lost']])
  })

  it('o UPDATE só fecha card AINDA aberto (WHERE status = open)', async () => {
    await markDealLostInPlace({ accountId: 'acc', userId: null, conversationId: 'conv-1', reason: 'Achou caro' })
    const q = whereSql(h.updates[0].where)
    expect(q.sql).toMatch(/"status" = \$\d/)
    expect(q.params).toContain('open')
    expect(q.params).toContain('deal-1')
    expect(q.params).toContain('acc')
  })

  it('corrida: outra mensagem fechou antes (UPDATE sem linha) → null, sem evento, sem nota, sem resgate', async () => {
    h.updateReturns = []
    const r = await markDealLostInPlace({
      accountId: 'acc',
      userId: 'u1',
      conversationId: 'conv-1',
      reason: 'Achou caro',
      note: 'x',
    })
    expect(r).toBeNull()
    expect(events()).toEqual([])
    expect(notes()).toEqual([])
    expect(h.crossFunnel).toEqual([])
  })

  it('sem comentário: o evento não ganha a chave note', async () => {
    await markDealLostInPlace({ accountId: 'acc', userId: null, conversationId: 'conv-1', reason: 'Achou caro' })
    expect(events()[0].values.data).not.toHaveProperty('note')
    expect(String(notes()[0].values.contentText)).not.toContain('💬')
  })

  it('lista travada: motivo inventado pela IA vira "Outros" e o texto vai pro comentário', async () => {
    h.settings = { lostReasons: ['Achou caro', 'Outros'], lostReasonsLocked: true }
    await markDealLostInPlace({
      accountId: 'acc',
      userId: null,
      conversationId: 'conv-1',
      reason: 'Mudou de cidade',
      note: 'volta em 2027',
      by: 'ai',
    })
    expect(h.updates[0].values.lostReason).toBe('Outros')
    expect(events()[0].values.data).toMatchObject({ reason: 'Outros', note: 'Mudou de cidade — volta em 2027' })
  })

  it('motivo do follow-up fica como está (nem consulta a lista)', async () => {
    h.settings = { lostReasons: ['Achou caro'], lostReasonsLocked: true }
    await markDealLostInPlace({
      accountId: 'acc',
      userId: null,
      conversationId: 'conv-1',
      reason: 'Não respondeu (3 follow-ups)',
      by: 'followup',
      followUps: 3,
    })
    expect(h.settingsCalls).toBe(0)
    expect(h.updates[0].values.lostReason).toBe('Não respondeu (3 follow-ups)')
    expect(events()[0].values.data).toMatchObject({ followUps: 3, by: 'followup' })
  })

  it('configurações indisponíveis → perde mesmo assim, com o texto da IA (e loga)', async () => {
    h.settingsThrows = true
    const r = await markDealLostInPlace({ accountId: 'acc', userId: null, conversationId: 'conv-1', reason: 'achou caro' })
    expect(r).not.toBeNull()
    expect(h.updates[0].values.lostReason).toBe('achou caro')
    expect(console.error).toHaveBeenCalled()
  })

  it('sem card aberto → null sem tocar em nada', async () => {
    h.openDeal = null
    expect(await markDealLostInPlace({ accountId: 'acc', userId: null, conversationId: 'conv-1' })).toBeNull()
    expect(h.updates).toEqual([])
    expect(h.inserts).toEqual([])
  })
})

describe('markDealWonInPlace', () => {
  it('ganha com WHERE status = open, evento e nota', async () => {
    const r = await markDealWonInPlace({ accountId: 'acc', userId: 'u1', conversationId: 'conv-1' })
    expect(r).toEqual({ dealId: 'deal-1', stageName: 'Qualificado' })
    const q = whereSql(h.updates[0].where)
    expect(q.sql).toMatch(/"status" = \$\d/)
    expect(q.params).toContain('open')
    expect(events()[0].values.data).toMatchObject({ from: 'open', to: 'won' })
    expect(notes()).toHaveLength(1)
    expect(h.crossFunnel).toEqual([['acc', 'u1', 'deal-1', 'won']])
  })

  it('corrida: duas mensagens juntas — a segunda não ganha de novo (null, sem evento/nota/pós-venda)', async () => {
    h.updateReturns = []
    expect(await markDealWonInPlace({ accountId: 'acc', userId: 'u1', conversationId: 'conv-1' })).toBeNull()
    expect(events()).toEqual([])
    expect(notes()).toEqual([])
    expect(h.crossFunnel).toEqual([])
  })
})

describe('applyCloseActions — loseNote', () => {
  it('perde em pé repassando o comentário', async () => {
    const r = await applyCloseActions({
      accountId: 'acc',
      userId: 'u1',
      conversationId: 'conv-1',
      resolve: false,
      funnelStageName: null,
      loseReason: 'Área sem clientes',
      loseNote: 'cidade X · capital Y',
    })
    expect(r.lost).toBe(true)
    expect(events()[0].values.data).toMatchObject({ reason: 'Área sem clientes', note: 'cidade X · capital Y' })
  })

  it('perde + abre no outro funil repassando o comentário', async () => {
    h.funnels = [{ pipelineId: 'pipe-2', pipelineName: '3. Comercial', stageId: 'n1', stageName: 'Novo lead' }]
    const r = await applyCloseActions({
      accountId: 'acc',
      userId: 'u1',
      conversationId: 'conv-1',
      resolve: false,
      funnelStageName: '3. Comercial > Novo lead',
      loseReason: 'Achou caro',
      loseNote: 'quer serviço avulso',
      allowCrossFunnel: true,
    })
    expect(r.lost).toBe(true)
    expect(r.spawnedDealId).toBe('deal-novo')
    expect(events()[0].values.data).toMatchObject({ reason: 'Achou caro', note: 'quer serviço avulso' })
  })

  it('corrida no fecha-e-abre: card já fechado → não abre card no outro funil', async () => {
    h.funnels = [{ pipelineId: 'pipe-2', pipelineName: '3. Comercial', stageId: 'n1', stageName: 'Novo lead' }]
    h.updateReturns = []
    const r = await applyCloseActions({
      accountId: 'acc',
      userId: 'u1',
      conversationId: 'conv-1',
      resolve: false,
      funnelStageName: '3. Comercial > Novo lead',
      win: true,
      allowCrossFunnel: true,
    })
    expect(r.won).toBe(false)
    expect(r.spawnedDealId ?? null).toBeNull()
    expect(h.spawned).toEqual([])
  })
})

describe('loadDealCloseContext — etapa atual', () => {
  it('devolve o nome da etapa em que o card ESTÁ junto com a lista', async () => {
    const ctx = await loadDealCloseContext('acc', 'conv-1')
    expect(ctx).toEqual({
      dealId: 'deal-1',
      pipelineId: 'pipe-1',
      currentStageId: 'st-2',
      currentStageName: 'Qualificado',
      stageNames: ['Novo lead', 'Qualificado', 'Reunião agendada'],
    })
  })

  it('etapa sumiu do funil → currentStageName null', async () => {
    h.openDeal = { id: 'deal-1', stageId: 'apagada', pipelineId: 'pipe-1' }
    expect((await loadDealCloseContext('acc', 'conv-1'))?.currentStageName).toBeNull()
  })
})

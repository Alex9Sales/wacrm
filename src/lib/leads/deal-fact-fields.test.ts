import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

import type { LeadFacts } from './lead-facts'

// Zelo 01/10: o marketing quer saber DE ONDE o lead veio, e a Campanha do card
// era trocada a cada conversão nova — inclusive pelas que o próprio RD CRM gera,
// que chegam com tudo "unknown". Banco trocado por um stub que registra o que
// seria gravado; o compare-and-swap é conferido pelo SQL renderizado. Ids e
// valores fictícios.
const h = vi.hoisted(() => ({
  fields: [] as { id: string; name: string }[],
  existing: [] as { customFieldId: string; value: string | null }[],
  inserts: [] as {
    values: { customFieldId: string; value: string }[]
    config: { setWhere?: unknown; set: Record<string, unknown> }
  }[],
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === actual.customFields ? h.fields : table === actual.dealCustomValues ? h.existing : [],
      }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: (config: { setWhere?: unknown; set: Record<string, unknown> }) => ({
          returning: async () => {
            const rows = (Array.isArray(values) ? values : [values]) as { customFieldId: string; value: string }[]
            h.inserts.push({ values: rows, config })
            return rows.map((_, i) => ({ id: `linha-${i}` }))
          },
        }),
      }),
    }),
  }
  return { ...actual, db }
})

import { fillDealFactFields } from './deal-fact-fields'

const dialect = new PgDialect()
const FIELDS = [
  { id: 'cf-campanha', name: 'Campanha' },
  { id: 'cf-cidade', name: 'Cidade' },
]
const facts = (over: Partial<LeadFacts>): LeadFacts => ({
  cidade: null,
  estado: null,
  investimento: null,
  inicio: null,
  interesse: null,
  campanha: null,
  ...over,
})
const written = () => h.inserts.flatMap((i) => i.values.map((v) => [v.customFieldId, v.value]))
const campaignInsert = () => h.inserts.find((i) => i.values.some((v) => v.customFieldId === 'cf-campanha'))

beforeEach(() => {
  h.fields = FIELDS
  h.existing = []
  h.inserts = []
})

describe('fillDealFactFields', () => {
  it('não sobrescreve uma Campanha boa; os outros fatos seguem "o mais novo vence"', async () => {
    h.existing = [{ customFieldId: 'cf-campanha', value: 'franquia-setembro' }]
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'outra-campanha', cidade: 'Campinas' }))
    expect(n).toBe(1)
    expect(written()).toEqual([['cf-cidade', 'Campinas']])
    // Cidade: upsert sem condição (o mais novo vence).
    expect(h.inserts[0].config.setWhere).toBeUndefined()
  })

  it('nunca grava campanha genérica', async () => {
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'unknown / unknown', cidade: 'Campinas' }))
    expect(n).toBe(1)
    expect(written()).toEqual([['cf-cidade', 'Campinas']])
  })

  it('troca uma "unknown" gravada antes pela primeira campanha boa — só se ela ainda estiver lá', async () => {
    h.existing = [{ customFieldId: 'cf-campanha', value: 'unknown' }]
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'franquia-setembro' }))
    expect(n).toBe(1)
    expect(written()).toEqual([['cf-campanha', 'franquia-setembro']])
    const q = dialect.sqlToQuery(campaignInsert()!.config.setWhere as SQL)
    expect(q.sql).toContain('"deal_custom_values"."value" IS NULL')
    expect(q.sql).toContain('btrim("deal_custom_values"."value")')
    expect(q.sql).toContain('"deal_custom_values"."value" = $1')
    expect(q.params).toEqual(['unknown'])
    expect(q.sql).not.toContain('--')
  })

  it('rótulo do RD CRM gravado como Campanha não conta como bom: é trocado', async () => {
    h.existing = [{ customFieldId: 'cf-campanha', value: 'Tarefa criada no RD Station CRM' }]
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'franquia-setembro' }))
    expect(n).toBe(1)
    expect(written()).toEqual([['cf-campanha', 'franquia-setembro']])
    expect(dialect.sqlToQuery(campaignInsert()!.config.setWhere as SQL).params).toEqual([
      'Tarefa criada no RD Station CRM',
    ])
  })

  it('nunca grava o rótulo do RD CRM como campanha', async () => {
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'RD Station CRM' }))
    expect(n).toBe(0)
    expect(h.inserts).toEqual([])
  })

  it('card sem Campanha: grava, e no conflito só ocupa o campo se continuar vazio', async () => {
    const n = await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'Facebook Ads / unknown' }))
    expect(n).toBe(1)
    // Parte genérica fora: "Facebook Ads / unknown" → "Facebook Ads".
    expect(written()).toEqual([['cf-campanha', 'Facebook Ads']])
    const q = dialect.sqlToQuery(campaignInsert()!.config.setWhere as SQL)
    expect(q.sql).toContain('IS NULL')
    expect(q.params).toEqual([])
  })

  it('conta sem campos de fato não grava nada', async () => {
    h.fields = [{ id: 'cf-x', name: 'Segmento' }]
    expect(await fillDealFactFields('conta-1', 'card-1', facts({ campanha: 'franquia-setembro' }))).toBe(0)
    expect(h.inserts).toEqual([])
  })
})

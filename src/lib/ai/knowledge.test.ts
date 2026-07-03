import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  interface FakeState {
    semantic: { id: string; content: string }[]
    fts: { id: string; content: string }[]
    chunkCount: number
    sqlCalls: string[]
    inserted: Record<string, unknown>[] | null
    deletedFor: string | null
  }
  const state: FakeState = {
    semantic: [],
    fts: [],
    chunkCount: 5, // account has a non-empty KB by default
    sqlCalls: [],
    inserted: null,
    deletedFor: null,
  }
  // Drizzle SQL/condition objects contain circular table references —
  // serialize with a cycle guard just to fish out fn names / params.
  function safeStringify(o: unknown): string {
    const seen = new WeakSet<object>()
    return JSON.stringify(o, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return undefined
        seen.add(v)
      }
      return v
    })
  }
  return { embedTexts: vi.fn(), state, safeStringify }
})

vi.mock('./embeddings', () => ({
  embedTexts: h.embedTexts,
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}))

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>()
  return {
    ...actual,
    db: {
      // retrieveKnowledge's empty-KB count guard:
      // select({ n: count() }).from().where() → [{ n }]
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ n: h.state.chunkCount }]),
        }),
      }),
      delete: () => ({
        where: (cond: unknown) => {
          // eq(aiKnowledgeChunks.documentId, documentId) — the param value
          // is embedded in the serialized condition.
          h.state.deletedFor = h.safeStringify(cond)
          return Promise.resolve()
        },
      }),
      insert: () => ({
        values: (rows: Record<string, unknown>[]) => {
          h.state.inserted = rows
          return Promise.resolve()
        },
      }),
      execute: (query: unknown) => {
        const s = h.safeStringify(query)
        if (s.includes('match_ai_knowledge_semantic')) {
          h.state.sqlCalls.push('match_ai_knowledge_semantic')
          return Promise.resolve({ rows: h.state.semantic })
        }
        if (s.includes('match_ai_knowledge_fts')) {
          h.state.sqlCalls.push('match_ai_knowledge_fts')
          return Promise.resolve({ rows: h.state.fts })
        }
        h.state.sqlCalls.push('unknown')
        return Promise.resolve({ rows: [] })
      },
    },
  }
})

import { retrieveKnowledge, ingestDocument } from './knowledge'

beforeEach(() => {
  h.state.semantic = []
  h.state.fts = []
  h.state.chunkCount = 5
  h.state.sqlCalls = []
  h.state.inserted = null
  h.state.deletedFor = null
  h.embedTexts.mockReset()
  h.embedTexts.mockImplementation(async (_key: string, inputs: string[]) =>
    inputs.map((_, i) => [i, i]),
  )
})

describe('retrieveKnowledge', () => {
  it('returns [] for an empty query without touching the DB', async () => {
    expect(await retrieveKnowledge('acct', { embeddingsApiKey: null }, '  ')).toEqual([])
    expect(h.state.sqlCalls).toEqual([])
  })

  it('short-circuits (no embed, no SQL) when the KB is empty', async () => {
    h.state.chunkCount = 0
    const out = await retrieveKnowledge('acct', { embeddingsApiKey: 'sk-x' }, 'q')
    expect(out).toEqual([])
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(h.state.sqlCalls).toEqual([])
  })

  it('uses lexical FTS only when there is no embeddings key', async () => {
    h.state.fts = [{ id: 'f1', content: 'F1' }]
    const out = await retrieveKnowledge('acct', { embeddingsApiKey: null }, 'q')
    expect(out).toEqual(['F1'])
    expect(h.state.sqlCalls).toEqual(['match_ai_knowledge_fts'])
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('uses semantic search when an embeddings key is present', async () => {
    h.state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
      { id: 's3', content: 'S3' },
    ]
    const out = await retrieveKnowledge('acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'S3'])
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    // Enough semantic hits → no FTS top-up.
    expect(h.state.sqlCalls).toEqual(['match_ai_knowledge_semantic'])
  })

  it('tops up with FTS and dedupes when semantic is short', async () => {
    h.state.semantic = [
      { id: 's1', content: 'S1' },
      { id: 's2', content: 'S2' },
    ]
    h.state.fts = [
      { id: 's2', content: 'S2-dup' }, // dedup by id
      { id: 'f1', content: 'F1' },
    ]
    const out = await retrieveKnowledge('acct', { embeddingsApiKey: 'sk-x' }, 'q', 3)
    expect(out).toEqual(['S1', 'S2', 'F1'])
    expect(h.state.sqlCalls).toEqual([
      'match_ai_knowledge_semantic',
      'match_ai_knowledge_fts',
    ])
  })
})

describe('ingestDocument', () => {
  it('embeds chunks when a key is present', async () => {
    await ingestDocument('acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world')
    expect(h.embedTexts).toHaveBeenCalledTimes(1)
    expect(h.state.deletedFor).toContain('doc-1')
    expect(h.state.inserted).toHaveLength(1)
    expect(h.state.inserted![0].embedding).toEqual([0, 0]) // from mocked embed
    expect(h.state.inserted![0].accountId).toBe('acct')
    expect(h.state.inserted![0].documentId).toBe('doc-1')
  })

  it('stores chunks without embeddings when there is no key', async () => {
    await ingestDocument('acct', { embeddingsApiKey: null }, 'doc-1', 'hello world')
    expect(h.embedTexts).not.toHaveBeenCalled()
    expect(h.state.inserted![0].embedding).toBeNull()
  })

  it('deletes existing chunks and inserts nothing for empty content', async () => {
    await ingestDocument('acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', '   ')
    expect(h.state.deletedFor).toContain('doc-1')
    expect(h.state.inserted).toBeNull()
    expect(h.embedTexts).not.toHaveBeenCalled()
  })

  it('still stores lexical chunks when embedding fails, then rethrows', async () => {
    h.embedTexts.mockRejectedValueOnce(new Error('rate limited'))
    await expect(
      ingestDocument('acct', { embeddingsApiKey: 'sk-x' }, 'doc-1', 'hello world'),
    ).rejects.toThrow('rate limited')
    // Chunks were inserted (lexical search works) despite the embed failure…
    expect(h.state.inserted).toHaveLength(1)
    expect(h.state.inserted![0].embedding).toBeNull()
  })
})

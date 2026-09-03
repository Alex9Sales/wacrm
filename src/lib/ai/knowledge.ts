import { and, count, eq, inArray, sql } from 'drizzle-orm'
import { db, aiKnowledgeChunks } from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { AiConfig } from './types'
import { chunkText } from './chunk'
import { embedTexts, toVectorLiteral } from './embeddings'
import { neutralizeUntrusted } from './untrusted'

// ============================================================
// Knowledge base: ingest (chunk + optionally embed) and hybrid
// retrieve (semantic when an embeddings key is present, topped up with
// lexical full-text search).
// ============================================================

interface MatchRow {
  id: string
  content: string
}

/**
 * (Re)build the chunks for one document. Deletes the document's
 * existing chunks, re-chunks the content, and — when the account has an
 * embeddings key — embeds each chunk.
 *
 * Throws on embedding failure so the ingest route can report it; the
 * chunks are only written once embedding (if attempted) succeeds, so a
 * failed embed never leaves half-indexed rows.
 */
/**
 * Texto que vai pro índice (chunks). Para Q&A, junta a PERGUNTA (título) com a
 * RESPOSTA (conteúdo) para o retrieval casar quando o cliente faz a pergunta.
 * Para os demais tipos (text/file/url), indexa só o conteúdo.
 */
export function buildIngestText(
  sourceType: string,
  title: string,
  content: string,
): string {
  // 🛡️ O documento da base foi escrito por gente de fora (upload/URL/colado):
  // desarma marcador e rótulo de sistema antes de virar contexto do agente.
  const safe = neutralizeUntrusted(content, { maxChars: 6000 })
  return sourceType === 'qa' ? `${neutralizeUntrusted(title, { maxChars: 300 })}\n\n${safe}` : safe
}

export async function ingestDocument(
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  documentId: string,
  content: string,
  knowledgeBaseId: string | null = null,
): Promise<void> {
  const chunks = chunkText(content)

  // Replace, don't append — re-ingest must be idempotent.
  await db
    .delete(aiKnowledgeChunks)
    .where(eq(aiKnowledgeChunks.documentId, documentId))

  if (chunks.length === 0) return

  // Embed if a key is set, but DON'T let an embedding failure stop the
  // chunks from being stored: a failed embed must still leave the
  // document searchable lexically. We record the error and rethrow it
  // AFTER inserting (embedding-less) rows, so the route can warn
  // "semantic indexing failed" — which is now truthful, because lexical
  // search really does still work.
  let embeddings: number[][] | null = null
  let embedError: unknown = null
  if (config.embeddingsApiKey) {
    try {
      embeddings = await embedTexts(config.embeddingsApiKey, chunks)
    } catch (err) {
      embedError = err
    }
  }

  const rows = chunks.map((content, i) => ({
    documentId,
    accountId,
    knowledgeBaseId,
    chunkIndex: i,
    content,
    embedding: embeddings ? embeddings[i] : null,
  }))

  await db.insert(aiKnowledgeChunks).values(rows)

  if (embedError) throw embedError
}

/**
 * Retrieve up to `k` knowledge excerpts relevant to `queryText`.
 *
 * Semantic-primary when an embeddings key is configured (embed the
 * query → cosine-nearest chunks), then topped up with lexical full-text
 * matches to fill `k`. Lexical-only when there's no key. Best-effort:
 * any failure (no KB, embedding error, SQL error) degrades to fewer or
 * zero results and never throws into the draft / auto-reply path.
 */
export async function retrieveKnowledge(
  accountId: string,
  config: Pick<AiConfig, 'embeddingsApiKey'>,
  queryText: string,
  k = 5,
  baseIds: string[] = [],
): Promise<string[]> {
  const query = queryText.trim()
  if (!query || k <= 0) return []

  // Fase K: o agente só enxerga as bases que ele escolheu (vazio = todas).
  // `ARRAY[...]::uuid[]` construído com sql.join — interpolar array JS cru com
  // ::uuid[] quebra (vira lista de placeholders). Ver [[drizzle-array-cast-gotcha]].
  const scoped = baseIds.length > 0
  const baseArr = scoped
    ? sql`ARRAY[${sql.join(baseIds.map((id) => sql`${id}::uuid`), sql`, `)}]::uuid[]`
    : sql`ARRAY[]::uuid[]`

  // Skip everything when the (scoped) knowledge base is empty — otherwise
  // every draft / auto-reply would pay for a query embedding + two SQL
  // calls just to get []. One cheap indexed COUNT instead of a paid
  // embeddings call on the hot path.
  try {
    const where = scoped
      ? and(
          eq(aiKnowledgeChunks.accountId, accountId),
          inArray(aiKnowledgeChunks.knowledgeBaseId, baseIds),
        )
      : eq(aiKnowledgeChunks.accountId, accountId)
    const row = firstOrNull(
      await db.select({ n: count() }).from(aiKnowledgeChunks).where(where),
    )
    if (!row || row.n === 0) return []
  } catch {
    return []
  }

  const picked = new Map<string, string>() // id → content, preserves order

  // Semantic path (deprioritized feature, kept compiling & functional —
  // the DB function still exists in the baseline).
  if (config.embeddingsApiKey) {
    try {
      const [queryEmbedding] = await embedTexts(config.embeddingsApiKey, [query])
      if (queryEmbedding) {
        const res = await db.execute(
          sql`SELECT * FROM match_ai_knowledge_semantic(${accountId}, ${toVectorLiteral(queryEmbedding)}, ${k}, ${baseArr})`,
        )
        for (const row of res.rows as unknown as MatchRow[]) {
          picked.set(row.id, row.content)
        }
      }
    } catch (err) {
      console.error('[ai knowledge] semantic retrieval failed, falling back to FTS:', err)
    }
  }

  // Lexical top-up (also the sole path when there's no embeddings key).
  if (picked.size < k) {
    try {
      const res = await db.execute(
        sql`SELECT * FROM match_ai_knowledge_fts(${accountId}, ${query}, ${k}, ${baseArr})`,
      )
      for (const row of res.rows as unknown as MatchRow[]) {
        if (picked.size >= k) break
        if (!picked.has(row.id)) picked.set(row.id, row.content)
      }
    } catch (err) {
      console.error('[ai knowledge] lexical retrieval failed:', err)
    }
  }

  return Array.from(picked.values()).slice(0, k)
}

import { and, asc, desc, eq, sql } from 'drizzle-orm'

import { db, aiKnowledgeBases, aiKnowledgeDocuments } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'

// ============================================================
// Fase K — Bases de conhecimento (nível CONTA). Cada agente escolhe quais usa
// (ai_configs.knowledge_base_ids, vazio = todas). Este módulo é o CRUD das
// bases + a garantia de que sempre exista uma base "Núcleo" onde cair os
// documentos criados sem base explícita (retrocompatível com o mundo 1-base).
// ============================================================

export interface KnowledgeBaseSummary {
  id: string
  name: string
  description: string | null
  documentCount: number
  updatedAt: string
}

/** Todas as bases da conta, com a contagem de documentos. Núcleo/antigas primeiro. */
export async function listBases(
  accountId: string,
): Promise<KnowledgeBaseSummary[]> {
  const rows = await db
    .select({
      id: aiKnowledgeBases.id,
      name: aiKnowledgeBases.name,
      description: aiKnowledgeBases.description,
      updatedAt: aiKnowledgeBases.updatedAt,
      documentCount: sql<number>`count(${aiKnowledgeDocuments.id})::int`,
    })
    .from(aiKnowledgeBases)
    .leftJoin(
      aiKnowledgeDocuments,
      eq(aiKnowledgeDocuments.knowledgeBaseId, aiKnowledgeBases.id),
    )
    .where(eq(aiKnowledgeBases.accountId, accountId))
    .groupBy(aiKnowledgeBases.id)
    .orderBy(asc(aiKnowledgeBases.createdAt))

  return rows.map((r) => ({
    id: r.id,
    name: r.name?.trim() || 'Base',
    description: r.description,
    documentCount: Number(r.documentCount ?? 0),
    updatedAt: r.updatedAt,
  }))
}

/**
 * Garante que a conta tenha ao menos uma base e devolve o id de destino padrão
 * (a base mais antiga = o "Núcleo"). Cria "Núcleo" se não houver nenhuma.
 * Usado quando um documento é criado sem base explícita.
 */
export async function ensureDefaultBaseId(
  accountId: string,
  createdBy: string | null = null,
): Promise<string> {
  const existing = firstOrNull(
    await db
      .select({ id: aiKnowledgeBases.id })
      .from(aiKnowledgeBases)
      .where(eq(aiKnowledgeBases.accountId, accountId))
      .orderBy(asc(aiKnowledgeBases.createdAt))
      .limit(1),
  )
  if (existing) return existing.id

  const created = firstOrThrow(
    await db
      .insert(aiKnowledgeBases)
      .values({
        accountId,
        createdBy,
        name: 'Geral',
        description: 'Base principal (todos os agentes usam por padrão)',
      })
      .returning({ id: aiKnowledgeBases.id }),
  )
  return created.id
}

/** Confirma que uma base pertence à conta (evita vazamento cross-account). */
export async function baseBelongsToAccount(
  accountId: string,
  baseId: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: aiKnowledgeBases.id })
      .from(aiKnowledgeBases)
      .where(
        and(
          eq(aiKnowledgeBases.id, baseId),
          eq(aiKnowledgeBases.accountId, accountId),
        ),
      )
      .limit(1),
  )
  return !!row
}

export async function createBase(
  accountId: string,
  createdBy: string | null,
  name: string,
  description: string | null,
): Promise<{ id: string }> {
  return firstOrThrow(
    await db
      .insert(aiKnowledgeBases)
      .values({
        accountId,
        createdBy,
        name: name.trim().slice(0, 80) || 'Nova base',
        description: description?.trim() || null,
      })
      .returning({ id: aiKnowledgeBases.id }),
  )
}

export async function updateBase(
  accountId: string,
  baseId: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() }
  if (typeof patch.name === 'string') set.name = patch.name.trim().slice(0, 80) || 'Base'
  if ('description' in patch) set.description = patch.description?.trim() || null
  await db
    .update(aiKnowledgeBases)
    .set(set)
    .where(
      and(eq(aiKnowledgeBases.id, baseId), eq(aiKnowledgeBases.accountId, accountId)),
    )
}

/** Apaga uma base (os documentos e chunks caem em cascata pela FK). */
export async function deleteBase(accountId: string, baseId: string): Promise<void> {
  await db
    .delete(aiKnowledgeBases)
    .where(
      and(eq(aiKnowledgeBases.id, baseId), eq(aiKnowledgeBases.accountId, accountId)),
    )
}

/** Nº de bases da conta (para não deixar apagar a última). */
export async function baseCount(accountId: string): Promise<number> {
  const rows = await db
    .select({ id: aiKnowledgeBases.id })
    .from(aiKnowledgeBases)
    .where(eq(aiKnowledgeBases.accountId, accountId))
    .orderBy(desc(aiKnowledgeBases.createdAt))
  return rows.length
}

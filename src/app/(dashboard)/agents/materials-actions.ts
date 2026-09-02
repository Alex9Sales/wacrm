'use server'

// ============================================================
// 📎 Materiais do agente — server actions do painel (Agentes IA → Materiais).
// O upload do arquivo é feito pelo cliente via /api/media/upload (bucket
// flow-media, path escopado por conta); aqui só gravamos o registro que a IA
// usa pra enviar ([[ENVIAR:nome]]). Admin+.
// ============================================================

import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { db, agentMaterials, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole } from '@/lib/auth/account'
import type { MaterialKind } from '@/lib/ai/materials-shared'

export interface AgentMaterialRow {
  id: string
  agentId: string | null
  name: string
  description: string | null
  mediaType: MaterialKind
  mediaUrl: string
  filename: string | null
  mimetype: string | null
  sizeBytes: number | null
  createdAt: string
}

const KINDS: MaterialKind[] = ['image', 'video', 'document']

/** Materiais visíveis na tela do agente: os dele + os "todos os agentes". */
export async function listAgentMaterials(
  agentId: string | null,
): Promise<AgentMaterialRow[]> {
  const ctx = await requireRole('admin')
  const rows = await db
    .select({
      id: agentMaterials.id,
      agentId: agentMaterials.agentId,
      name: agentMaterials.name,
      description: agentMaterials.description,
      mediaType: agentMaterials.mediaType,
      mediaUrl: agentMaterials.mediaUrl,
      filename: agentMaterials.filename,
      mimetype: agentMaterials.mimetype,
      sizeBytes: agentMaterials.sizeBytes,
      createdAt: agentMaterials.createdAt,
    })
    .from(agentMaterials)
    .where(
      and(
        eq(agentMaterials.accountId, ctx.accountId),
        agentId
          ? or(isNull(agentMaterials.agentId), eq(agentMaterials.agentId, agentId))
          : isNull(agentMaterials.agentId),
      ),
    )
    .orderBy(agentMaterials.name)
  return rows.map((r) => ({ ...r, mediaType: r.mediaType as MaterialKind }))
}

/**
 * Cria/atualiza um material. `agentId` null = todos os agentes. Ao criar,
 * LIGA a ferramenta `send_material` no(s) agente(s) alvo — senão o dono sobe
 * o arquivo e a IA nunca manda (armadilha de suporte).
 */
export async function saveAgentMaterial(input: {
  id?: string | null
  agentId: string | null
  name: string
  description?: string | null
  mediaType: MaterialKind
  mediaUrl: string
  filename?: string | null
  mimetype?: string | null
  sizeBytes?: number | null
}): Promise<{ id: string | null; error: string | null }> {
  try {
    const ctx = await requireRole('admin')
    const name = (input.name ?? '').trim().replace(/[[\]]/g, '').slice(0, 80)
    if (!name) return { id: null, error: 'Dê um nome curto pro material (é o que a IA escreve).' }
    if (!KINDS.includes(input.mediaType)) return { id: null, error: 'Tipo inválido.' }
    const mediaUrl = (input.mediaUrl ?? '').trim()
    if (!/^https?:\/\//i.test(mediaUrl)) return { id: null, error: 'Arquivo não enviado.' }
    const description = (input.description ?? '').trim().slice(0, 400) || null

    // agent_id só se o agente for desta conta.
    let agentId: string | null = null
    if (input.agentId) {
      const ag = firstOrNull(
        await db
          .select({ id: aiConfigs.id })
          .from(aiConfigs)
          .where(and(eq(aiConfigs.id, input.agentId), eq(aiConfigs.accountId, ctx.accountId)))
          .limit(1),
      )
      if (!ag) return { id: null, error: 'Agente não encontrado.' }
      agentId = ag.id
    }

    // Nome único na conta (é a chave que a IA usa).
    const dup = firstOrNull(
      await db
        .select({ id: agentMaterials.id })
        .from(agentMaterials)
        .where(
          and(
            eq(agentMaterials.accountId, ctx.accountId),
            sql`lower(${agentMaterials.name}) = lower(${name})`,
          ),
        )
        .limit(1),
    )
    if (dup && dup.id !== input.id) {
      return { id: null, error: `Já existe um material chamado "${name}".` }
    }

    let id: string
    if (input.id) {
      const updated = firstOrNull(
        await db
          .update(agentMaterials)
          .set({
            agentId,
            name,
            description,
            mediaType: input.mediaType,
            mediaUrl,
            filename: input.filename ?? null,
            mimetype: input.mimetype ?? null,
            sizeBytes: input.sizeBytes ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(and(eq(agentMaterials.id, input.id), eq(agentMaterials.accountId, ctx.accountId)))
          .returning({ id: agentMaterials.id }),
      )
      if (!updated) return { id: null, error: 'Material não encontrado.' }
      id = updated.id
    } else {
      const inserted = firstOrNull(
        await db
          .insert(agentMaterials)
          .values({
            accountId: ctx.accountId,
            agentId,
            name,
            description,
            mediaType: input.mediaType,
            mediaUrl,
            filename: input.filename ?? null,
            mimetype: input.mimetype ?? null,
            sizeBytes: input.sizeBytes ?? null,
            createdBy: ctx.userId,
          })
          .returning({ id: agentMaterials.id }),
      )
      if (!inserted) return { id: null, error: 'Não foi possível salvar.' }
      id = inserted.id
    }

    // Liga a ferramenta send_material no(s) agente(s) alvo (idempotente).
    try {
      await db
        .update(aiConfigs)
        .set({
          tools: sql`(
            CASE WHEN ${aiConfigs.tools} ? 'send_material'
              THEN ${aiConfigs.tools}
              ELSE ${aiConfigs.tools} || '["send_material"]'::jsonb
            END
          )`,
        })
        .where(
          and(
            eq(aiConfigs.accountId, ctx.accountId),
            agentId ? eq(aiConfigs.id, agentId) : sql`true`,
          ),
        )
    } catch (err) {
      console.error('[materials] ligar send_material falhou:', err)
    }

    return { id, error: null }
  } catch (err) {
    return { id: null, error: err instanceof Error ? err.message : 'Erro' }
  }
}

export async function deleteAgentMaterial(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('admin')
    await db
      .delete(agentMaterials)
      .where(and(eq(agentMaterials.id, id), eq(agentMaterials.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Erro' }
  }
}

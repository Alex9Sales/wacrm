// ============================================================
// 📎 Materiais do agente — parte com BANCO (worker-reachable, sem 'server-only').
// Tipos/parser/prompt ficam em materials-shared.ts (client-safe).
// ============================================================

import { and, eq, isNull, or } from 'drizzle-orm'

import { db, agentMaterials } from '@/db'

import type { AgentMaterial, MaterialKind } from './materials-shared'

export * from './materials-shared'

/** Materiais disponíveis pro agente (os dele + os "todos os agentes"). */
export async function listMaterialsForAgent(
  accountId: string,
  agentId: string | null,
): Promise<AgentMaterial[]> {
  const rows = await db
    .select({
      id: agentMaterials.id,
      name: agentMaterials.name,
      description: agentMaterials.description,
      mediaType: agentMaterials.mediaType,
      mediaUrl: agentMaterials.mediaUrl,
      filename: agentMaterials.filename,
      mimetype: agentMaterials.mimetype,
    })
    .from(agentMaterials)
    .where(
      and(
        eq(agentMaterials.accountId, accountId),
        agentId
          ? or(isNull(agentMaterials.agentId), eq(agentMaterials.agentId, agentId))
          : isNull(agentMaterials.agentId),
      ),
    )
    .orderBy(agentMaterials.name)
  return rows.map((r) => ({ ...r, mediaType: r.mediaType as MaterialKind }))
}

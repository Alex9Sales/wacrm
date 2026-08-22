// Distribuição automática de leads (rodízio). Escolhe o próximo responsável
// pra um lead que entra sem dono (diagnóstico, anúncios, API). Config por conta
// em `lead_distribution`. NÃO importar 'server-only' aqui: é worker-reachable
// via ingestLead.

import { and, eq, inArray, sql } from 'drizzle-orm'

import { db, deals, leadDistribution, member } from '@/db'

export interface LeadDistributionConfig {
  enabled: boolean
  strategy: 'round_robin' | 'load'
  memberIds: string[]
}

function toIds(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
}

/** Config atual da distribuição da conta (default = desligada). */
export async function loadLeadDistribution(
  accountId: string,
): Promise<LeadDistributionConfig> {
  const row = (
    await db
      .select()
      .from(leadDistribution)
      .where(eq(leadDistribution.accountId, accountId))
      .limit(1)
  )[0]
  if (!row) return { enabled: false, strategy: 'round_robin', memberIds: [] }
  return {
    enabled: row.enabled,
    strategy: row.strategy === 'load' ? 'load' : 'round_robin',
    memberIds: toIds(row.memberIds),
  }
}

/**
 * Escolhe o próximo responsável do rodízio pra um lead novo, e AVANÇA o rodízio.
 * Retorna null quando a distribuição está desligada, sem membros, ou nenhum
 * membro configurado ainda pertence à conta. Serializa por conta (SELECT ...
 * FOR UPDATE) pra dois leads simultâneos não caírem na mesma pessoa.
 */
export async function pickAssignee(accountId: string): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      const cfg = (
        await tx
          .select()
          .from(leadDistribution)
          .where(eq(leadDistribution.accountId, accountId))
          .for('update')
          .limit(1)
      )[0]
      if (!cfg || !cfg.enabled) return null

      const configured = toIds(cfg.memberIds)
      if (configured.length === 0) return null

      // Só membros que AINDA pertencem à conta (preserva a ordem configurada).
      const current = await tx
        .select({ userId: member.userId })
        .from(member)
        .where(
          and(
            eq(member.organizationId, accountId),
            inArray(member.userId, configured),
          ),
        )
      const valid = new Set(current.map((m) => m.userId))
      const pool = configured.filter((id) => valid.has(id))
      if (pool.length === 0) return null

      let picked: string
      if (cfg.strategy === 'load') {
        // Menor nº de negócios ABERTOS entre os do pool.
        const counts = await tx
          .select({ uid: deals.assignedTo, n: sql<number>`count(*)::int` })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.status, 'open'),
              inArray(deals.assignedTo, pool),
            ),
          )
          .groupBy(deals.assignedTo)
        const byId = new Map<string, number>()
        for (const c of counts) if (c.uid) byId.set(c.uid, Number(c.n))
        picked = pool[0]
        let min = byId.get(picked) ?? 0
        for (const id of pool) {
          const n = byId.get(id) ?? 0
          if (n < min) {
            min = n
            picked = id
          }
        }
      } else {
        // Round-robin: o próximo depois do último atribuído.
        const lastIdx = cfg.lastAssignedUserId
          ? pool.indexOf(cfg.lastAssignedUserId)
          : -1
        picked = pool[(lastIdx + 1) % pool.length]
      }

      await tx
        .update(leadDistribution)
        .set({ lastAssignedUserId: picked, updatedAt: new Date().toISOString() })
        .where(eq(leadDistribution.accountId, accountId))
      return picked
    })
  } catch (err) {
    console.error('[pickAssignee]', err)
    return null
  }
}

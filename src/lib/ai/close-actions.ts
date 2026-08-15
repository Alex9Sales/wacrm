// ============================================================
// Encerramento inteligente — ações que a IA pode disparar ao terminar um
// atendimento (via marcadores no texto gerado). Server/worker-safe: recebe
// accountId/userId explícitos (não usa sessão). Best-effort: nunca lança.
//
//   [[RESOLVER]]        → fecha a conversa (status 'closed').
//   [[FUNIL:<etapa>]]   → move o card do funil ligado pra etapa cujo NOME casa.
//
// A IA escolhe a etapa pelo nome (injetamos as etapas do funil no prompt).
// ============================================================

import { and, desc, eq, sql } from 'drizzle-orm'
import { db, deals, pipelineStages, conversations, dealEvents } from '@/db'
import { firstOrNull } from '@/db/helpers'

export interface DealCloseContext {
  dealId: string
  pipelineId: string
  currentStageId: string
  /** Nomes das etapas do funil do deal — a IA escolhe uma pelo nome. */
  stageNames: string[]
}

/** Deal ABERTO ligado à conversa + as etapas do funil dele. Null se não há. */
export async function loadDealCloseContext(
  accountId: string,
  conversationId: string,
): Promise<DealCloseContext | null> {
  const deal = firstOrNull(
    await db
      .select({
        id: deals.id,
        pipelineId: deals.pipelineId,
        stageId: deals.stageId,
      })
      .from(deals)
      .where(
        and(
          eq(deals.accountId, accountId),
          eq(deals.conversationId, conversationId),
          eq(deals.status, 'open'),
        ),
      )
      .orderBy(desc(deals.createdAt))
      .limit(1),
  )
  if (!deal) return null
  const stages = await db
    .select({ name: pipelineStages.name })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, deal.pipelineId))
    .orderBy(pipelineStages.position)
  return {
    dealId: deal.id,
    pipelineId: deal.pipelineId,
    currentStageId: deal.stageId,
    stageNames: stages.map((s) => s.name),
  }
}

/** Casa nome de etapa tolerante a acento/caixa/espaço. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Executa as ações de encerramento decididas pela IA. Best-effort, nunca lança.
 * Devolve o que fez (pra log).
 */
export async function applyCloseActions(input: {
  accountId: string
  userId: string | null
  conversationId: string
  resolve: boolean
  funnelStageName: string | null
}): Promise<{ resolved: boolean; movedTo: string | null }> {
  const { accountId, userId, conversationId, resolve, funnelStageName } = input
  let resolved = false
  let movedTo: string | null = null

  // 1) Mover o card do funil (se a IA pediu e casar uma etapa do funil do deal).
  if (funnelStageName && funnelStageName.trim()) {
    try {
      const deal = firstOrNull(
        await db
          .select({
            id: deals.id,
            pipelineId: deals.pipelineId,
            stageId: deals.stageId,
          })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.conversationId, conversationId),
              eq(deals.status, 'open'),
            ),
          )
          .orderBy(desc(deals.createdAt))
          .limit(1),
      )
      if (deal) {
        const stages = await db
          .select({ id: pipelineStages.id, name: pipelineStages.name })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, deal.pipelineId))
        const want = norm(funnelStageName)
        let target =
          stages.find((s) => norm(s.name) === want) ??
          stages.find(
            (s) => norm(s.name).includes(want) || want.includes(norm(s.name)),
          )
        if (target && target.id !== deal.stageId) {
          const fromName =
            stages.find((s) => s.id === deal.stageId)?.name ?? null
          await db
            .update(deals)
            .set({ stageId: target.id, stageChangedAt: sql`now()` })
            .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
          try {
            await db.insert(dealEvents).values({
              accountId,
              actorUserId: userId || null,
              dealId: deal.id,
              type: 'stage_changed',
              data: { from: fromName, to: target.name, by: 'ai' },
            })
          } catch (err) {
            console.error('[ai close] deal event falhou:', err)
          }
          movedTo = target.name
        }
      }
    } catch (err) {
      console.error('[ai close] mover funil falhou:', err)
    }
  }

  // 2) Resolver (fechar) a conversa.
  if (resolve) {
    try {
      await db
        .update(conversations)
        .set({ status: 'closed' })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, accountId),
          ),
        )
      resolved = true
    } catch (err) {
      console.error('[ai close] resolver conversa falhou:', err)
    }
  }

  return { resolved, movedTo }
}

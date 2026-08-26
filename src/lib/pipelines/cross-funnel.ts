// ============================================================
// 🔀 Funil→funil no ganho/perda (ideia do cliente Dentai, 26/08).
// Quando um negócio é GANHO ou PERDIDO e a conta configurou um funil de
// destino (Config→Negócios: pós-venda no ganho, resgate na perda), abre um
// NOVO negócio no funil de destino — o original fica onde está, com o status
// dele, preservando os relatórios do funil de origem (Raio-X/conversão).
// Opt-in por conta (null = não move). Best-effort: nunca derruba o
// ganho/perda que o disparou. Sem 'server-only' — worker-reachable
// (a perda automática da cadência também dispara).
// ============================================================

import { and, asc, eq } from 'drizzle-orm'

import { db, deals, dealEvents, pipelines, pipelineStages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'

/**
 * Abre o negócio-espelho no funil de destino do evento (won → wonPipelineId,
 * lost → lostPipelineId). Guardas: destino não configurado, negócio já no
 * funil de destino (anti-loop), ou contato já com negócio ABERTO no destino
 * (anti-duplicata) → não faz nada.
 */
export async function maybeSpawnCrossFunnelDeal(
  accountId: string,
  userId: string | null,
  dealId: string,
  kind: 'won' | 'lost',
): Promise<void> {
  try {
    const s = await getAccountSettings(accountId)
    const targetPipelineId = kind === 'won' ? s.wonPipelineId : s.lostPipelineId
    if (!targetPipelineId) return

    const deal = firstOrNull(
      await db
        .select({
          id: deals.id,
          pipelineId: deals.pipelineId,
          contactId: deals.contactId,
          conversationId: deals.conversationId,
          companyId: deals.companyId,
          title: deals.title,
          value: deals.value,
          currency: deals.currency,
          assignedTo: deals.assignedTo,
          userId: deals.userId,
        })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
        .limit(1),
    )
    if (!deal) return
    if (deal.pipelineId === targetPipelineId) return // anti-loop

    // Funil de destino precisa existir NESTA conta (config velha pode apontar
    // pra funil apagado) e ter uma 1ª etapa.
    const target = firstOrNull(
      await db
        .select({ id: pipelines.id, name: pipelines.name })
        .from(pipelines)
        .where(and(eq(pipelines.id, targetPipelineId), eq(pipelines.accountId, accountId)))
        .limit(1),
    )
    if (!target) return
    const stage = firstOrNull(
      await db
        .select({ id: pipelineStages.id, name: pipelineStages.name })
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, target.id))
        .orderBy(asc(pipelineStages.position))
        .limit(1),
    )
    if (!stage) return

    // Anti-duplicata: o contato já tem negócio ABERTO no funil de destino.
    if (deal.contactId) {
      const dup = firstOrNull(
        await db
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.pipelineId, target.id),
              eq(deals.contactId, deal.contactId),
              eq(deals.status, 'open'),
            ),
          )
          .limit(1),
      )
      if (dup) return
    }

    const [created] = await db
      .insert(deals)
      .values({
        accountId,
        pipelineId: target.id,
        stageId: stage.id,
        contactId: deal.contactId,
        conversationId: deal.conversationId,
        companyId: deal.companyId,
        title: deal.title,
        value: deal.value,
        currency: deal.currency,
        status: 'open',
        assignedTo: deal.assignedTo,
        userId: userId || deal.userId,
        stageChangedAt: new Date().toISOString(),
      })
      .returning({ id: deals.id })
    if (!created) return

    try {
      await db.insert(dealEvents).values({
        accountId,
        actorUserId: userId,
        dealId: created.id,
        type: 'created',
        data: {
          by: 'funnel_automation',
          from: kind,
          fromDealId: deal.id,
          toPipeline: target.name,
        },
      })
    } catch (err) {
      console.error('[cross-funnel] deal event falhou:', err)
    }
    // Atividades automáticas da etapa de entrada (mesmo comportamento da
    // criação normal). Import dinâmico: stage-tasks é web-side.
    try {
      const { autoCreateStageTasks } = await import('@/lib/pipelines/stage-tasks')
      await autoCreateStageTasks({ accountId, userId }, created.id, stage.id)
    } catch (err) {
      console.error('[cross-funnel] stage tasks falhou:', err)
    }
    console.log(
      `[cross-funnel] ${kind}: negócio ${deal.id} → novo ${created.id} no funil "${target.name}"`,
    )
  } catch (err) {
    console.error('[cross-funnel] maybeSpawnCrossFunnelDeal:', err)
  }
}

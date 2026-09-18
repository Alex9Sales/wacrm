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

import { and, asc, eq, isNull } from 'drizzle-orm'

import { db, deals, dealCustomValues, dealEvents, pipelines, pipelineStages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getAccountSettings } from '@/lib/settings/account-settings'

/**
 * Abre o PRÓXIMO card num funil/etapa ESCOLHIDOS, a partir de um card que
 * acabou de ser ganho ou perdido. Diferente do automático por conta (abaixo,
 * sempre a 1ª etapa do funil configurado): aqui quem escolhe o destino é quem
 * fechou — a IA com "[[GANHO]]/[[PERDER:…]] + [[FUNIL:<funil> > <etapa>]]".
 *
 * Zelo 18/09 (Jordan): o pré-vendas registra ONDE o lead converteu (ganho na
 * 4ª tentativa) ou por que saiu (perdido: "Lead interessado em serviço"), e o
 * comercial recebe um card NOVO — assim dá pra medir cada campanha.
 *
 * Copia contato, conversa, título, valor, dono, observações, origem e os campos
 * personalizados. Contato que já tem card ABERTO no funil de destino não ganha
 * outro: devolve o existente (e liga à conversa, se ele não tinha). Nunca lança.
 */
export async function spawnDealInFunnel(input: {
  accountId: string
  userId: string | null
  sourceDealId: string
  pipelineId: string
  stageId: string
  kind: 'won' | 'lost'
  by?: 'ai' | 'system'
}): Promise<{ dealId: string; created: boolean } | null> {
  const { accountId, userId, sourceDealId, pipelineId, stageId, kind } = input
  try {
    const src = firstOrNull(
      await db
        .select({
          id: deals.id,
          contactId: deals.contactId,
          conversationId: deals.conversationId,
          companyId: deals.companyId,
          title: deals.title,
          value: deals.value,
          currency: deals.currency,
          assignedTo: deals.assignedTo,
          userId: deals.userId,
          notes: deals.notes,
          origin: deals.origin,
          source: deals.source,
        })
        .from(deals)
        .where(and(eq(deals.id, sourceDealId), eq(deals.accountId, accountId)))
        .limit(1),
    )
    if (!src) return null
    const target = firstOrNull(
      await db
        .select({ pipelineName: pipelines.name, stageName: pipelineStages.name })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
        .where(
          and(
            eq(pipelineStages.id, stageId),
            eq(pipelineStages.pipelineId, pipelineId),
            eq(pipelines.accountId, accountId),
          ),
        )
        .limit(1),
    )
    if (!target) return null

    if (src.contactId) {
      const open = firstOrNull(
        await db
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.pipelineId, pipelineId),
              eq(deals.contactId, src.contactId),
              eq(deals.status, 'open'),
            ),
          )
          .limit(1),
      )
      if (open) {
        if (src.conversationId) {
          await db
            .update(deals)
            .set({ conversationId: src.conversationId })
            .where(and(eq(deals.id, open.id), isNull(deals.conversationId)))
        }
        return { dealId: open.id, created: false }
      }
    }

    const [created] = await db
      .insert(deals)
      .values({
        accountId,
        pipelineId,
        stageId,
        contactId: src.contactId,
        conversationId: src.conversationId,
        companyId: src.companyId,
        title: src.title,
        value: src.value,
        currency: src.currency,
        status: 'open',
        assignedTo: src.assignedTo,
        userId: userId || src.userId,
        notes: src.notes,
        origin: src.origin,
        source: src.source,
        stageChangedAt: new Date().toISOString(),
      })
      .returning({ id: deals.id })
    if (!created) return null

    try {
      const values = await db
        .select({ customFieldId: dealCustomValues.customFieldId, value: dealCustomValues.value })
        .from(dealCustomValues)
        .where(eq(dealCustomValues.dealId, src.id))
      if (values.length) {
        await db
          .insert(dealCustomValues)
          .values(values.map((v) => ({ accountId, dealId: created.id, customFieldId: v.customFieldId, value: v.value })))
          .onConflictDoNothing()
      }
    } catch (err) {
      console.error('[cross-funnel] cópia dos campos falhou:', err)
    }
    try {
      await db.insert(dealEvents).values({
        accountId,
        actorUserId: userId,
        dealId: created.id,
        type: 'created',
        data: {
          by: input.by ?? 'ai',
          from: kind,
          fromDealId: src.id,
          toPipeline: target.pipelineName,
          toStage: target.stageName,
        },
      })
    } catch (err) {
      console.error('[cross-funnel] deal event falhou:', err)
    }
    try {
      const { autoCreateStageTasks } = await import('@/lib/pipelines/stage-tasks')
      await autoCreateStageTasks({ accountId, userId }, created.id, stageId)
    } catch (err) {
      console.error('[cross-funnel] stage tasks falhou:', err)
    }
    console.log(
      `[cross-funnel] ${kind} → novo card ${created.id} em "${target.pipelineName} › ${target.stageName}" (de ${src.id})`,
    )
    return { dealId: created.id, created: true }
  } catch (err) {
    console.error('[cross-funnel] spawnDealInFunnel:', err)
    return null
  }
}

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

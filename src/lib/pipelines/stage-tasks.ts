import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { db, tasks, deals, stageTaskTemplates } from '@/db'
import { firstOrNull } from '@/db/helpers'

// ============================================================
// Atividades automáticas por etapa (item 2 do funil).
// Quando um negócio ENTRA numa etapa, materializa os templates de tarefa da
// etapa em linhas de `tasks` para o responsável do negócio. Dedupe por
// (deal, template) via tasks.source_template_id → reentrar não duplica.
// ============================================================

/**
 * Cria as tarefas automáticas da etapa para um negócio. Best-effort: NUNCA
 * lança (o chamador é caminho crítico de criar/mover negócio). Retorna
 * quantas tarefas criou (0 se a etapa não tem templates ou já foram criadas).
 */
export async function autoCreateStageTasks(
  ctx: { accountId: string; userId: string | null },
  dealId: string,
  stageId: string,
): Promise<number> {
  try {
    const templates = await db
      .select({
        id: stageTaskTemplates.id,
        title: stageTaskTemplates.title,
        description: stageTaskTemplates.description,
        dueOffsetDays: stageTaskTemplates.dueOffsetDays,
        type: stageTaskTemplates.type,
      })
      .from(stageTaskTemplates)
      .where(
        and(
          eq(stageTaskTemplates.stageId, stageId),
          eq(stageTaskTemplates.accountId, ctx.accountId),
          eq(stageTaskTemplates.active, true),
        ),
      )
      .orderBy(asc(stageTaskTemplates.position))
    if (templates.length === 0) return 0

    // Dedupe: quais desses templates JÁ viraram tarefa neste negócio.
    const templateIds = templates.map((t) => t.id)
    const existing = await db
      .select({ tid: tasks.sourceTemplateId })
      .from(tasks)
      .where(
        and(eq(tasks.dealId, dealId), inArray(tasks.sourceTemplateId, templateIds)),
      )
    const alreadyDone = new Set(existing.map((e) => e.tid))
    const todo = templates.filter((t) => !alreadyDone.has(t.id))
    if (todo.length === 0) return 0

    // Contato + responsável do negócio (fallback: dono/criador do negócio).
    const deal = firstOrNull(
      await db
        .select({
          contactId: deals.contactId,
          userId: deals.userId,
          assignedTo: deals.assignedTo,
        })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!deal) return 0
    const owner = deal.assignedTo ?? deal.userId ?? null

    // ON CONFLICT DO NOTHING blinda contra corrida/duplo-hook: o índice único
    // parcial em (deal_id, source_template_id) garante no máx. 1 por par. A
    // contagem retornada = linhas REALMENTE inseridas.
    const inserted = await db
      .insert(tasks)
      .values(
        todo.map((t) => ({
          accountId: ctx.accountId,
          title: t.title,
          description: t.description,
          // vence em N dias a partir de agora (0 = hoje).
          dueAt: sql`now() + (${t.dueOffsetDays}::int * interval '1 day')`,
          status: 'open' as const,
          type: t.type,
          contactId: deal.contactId,
          dealId,
          assignedTo: owner,
          assigneeIds: owner ? [owner] : [],
          createdBy: ctx.userId,
          sourceTemplateId: t.id,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: tasks.id })
    return inserted.length
  } catch (err) {
    console.error('[autoCreateStageTasks]', err)
    return 0
  }
}

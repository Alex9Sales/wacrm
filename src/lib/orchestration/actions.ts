// ============================================================
// ⚙️ Fase 2 — EXECUTOR das ações (worker-reachable, SEM 'server-only').
// Uma função por ação; todas escopadas por conta e best-effort nos efeitos
// colaterais secundários (tarefa da etapa, follow-up planejado…).
//
// Ações "só humano" (send_proposal, apply_discount, close_deal) NÃO rodam
// aqui: dependem de Server Actions com sessão (side effects do app). A fila
// de aprovação executa essas com o usuário que aprovou.
// ============================================================

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  db,
  cadenceEnrollments,
  dealProducts,
  dealProposals,
  conversations,
  dealEvents,
  deals,
  member,
  notifications,
  pipelineStages,
  tasks,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { cancelEnrollment, enrollContactInCadence } from '@/lib/cadences/cadence'
import { publishEvent } from '@/lib/events/publish'
import { engineSendText } from '@/lib/flows/meta-send'
import { planStageFollowUp } from '@/lib/ai/followup'
import { autoCreateStageTasks } from '@/lib/pipelines/stage-tasks'

import { ACTION_CATALOG, type OrchAction } from './policy'

export interface ExecInput {
  accountId: string
  /** Humano que aprovou (null = a IA decidiu sozinha). */
  actorUserId: string | null
  /** Agente cuja política decidiu (auditoria). */
  agentId: string | null
  action: OrchAction
  contactId: string
  dealId: string | null
  conversationId: string | null
  /** Texto da mensagem (ações de mensagem). */
  text: string | null
  /** Motivo em português (vai pra notificação/tarefa). */
  reason: string
  payload: Record<string, unknown>
}

export interface ExecResult {
  ok: boolean
  result?: Record<string, unknown>
  error?: string
  /** Ação exige sessão humana (fila executa com o aprovador). */
  needsHuman?: boolean
}

export const FOLLOW_UP_NEXT_HOURS = 48

async function loadDeal(accountId: string, dealId: string) {
  return firstOrNull(
    await db
      .select({
        id: deals.id,
        title: deals.title,
        assignedTo: deals.assignedTo,
        conversationId: deals.conversationId,
        stageId: deals.stageId,
        pipelineId: deals.pipelineId,
        status: deals.status,
        contactId: deals.contactId,
      })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  )
}

async function resolveConversationId(accountId: string, contactId: string, hint: string | null, dealConversationId: string | null) {
  if (hint) return hint
  if (dealConversationId) return dealConversationId
  const c = firstOrNull(
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
  return c?.id ?? null
}

async function adminUserIds(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, accountId), inArray(member.role, ['owner', 'admin'])))
  return rows.map((r) => r.userId)
}

/** Quem assina o envio quando a IA age sozinha: dono do negócio → dono da conversa → primeiro admin. */
async function senderUserId(accountId: string, actorUserId: string | null, deal: { assignedTo: string | null } | null, conversationId: string | null) {
  if (actorUserId) return actorUserId
  if (deal?.assignedTo) return deal.assignedTo
  if (conversationId) {
    const c = firstOrNull(
      await db.select({ userId: conversations.userId, assigned: conversations.assignedAgentId }).from(conversations).where(eq(conversations.id, conversationId)).limit(1),
    )
    if (c?.assigned) return c.assigned
    if (c?.userId) return c.userId
  }
  const admins = await adminUserIds(accountId)
  return admins[0] ?? ''
}

export async function notifyUsers(args: {
  accountId: string
  userIds: string[]
  type: 'agent_action' | 'approval_required' | 'task_assigned'
  title: string
  body: string | null
  contactId?: string | null
  dealId?: string | null
  conversationId?: string | null
}): Promise<number> {
  const ids = Array.from(new Set(args.userIds.filter(Boolean)))
  if (ids.length === 0) return 0
  await db.insert(notifications).values(
    ids.map((userId) => ({
      accountId: args.accountId,
      userId,
      type: args.type,
      title: args.title.slice(0, 200),
      body: args.body ? args.body.slice(0, 1000) : null,
      contactId: args.contactId ?? null,
      dealId: args.dealId ?? null,
      conversationId: args.conversationId ?? null,
    })),
  )
  await publishEvent(args.accountId, { type: 'notification' })
  return ids.length
}

/** Nota no histórico do negócio (explicabilidade). */
export async function noteDealEvent(accountId: string, dealId: string, actorUserId: string | null, text: string): Promise<void> {
  try {
    await db.insert(dealEvents).values({ accountId, actorUserId, dealId, type: 'note', data: { text, by: actorUserId ? 'human' : 'ai' } })
  } catch (err) {
    console.error('[orchestration] deal event falhou:', err instanceof Error ? err.message : err)
  }
}

export async function executeOrchestrationAction(input: ExecInput): Promise<ExecResult> {
  const meta = ACTION_CATALOG[input.action]
  if (meta.humanOnly) return { ok: false, needsHuman: true, error: 'Esta ação só o humano executa (aprove na fila "Precisa de você").' }

  const deal = input.dealId ? await loadDeal(input.accountId, input.dealId) : null
  if (input.dealId && !deal) return { ok: false, error: 'Negócio não encontrado.' }

  try {
    switch (input.action) {
      case 'send_followup':
      case 'reactivation': {
        const text = (input.text ?? '').trim()
        if (!text) return { ok: false, error: 'Sem texto pra enviar.' }
        const conversationId = await resolveConversationId(input.accountId, input.contactId, input.conversationId, deal?.conversationId ?? null)
        if (!conversationId) return { ok: false, error: 'Contato sem conversa aberta — não dá pra mandar mensagem.' }
        const userId = await senderUserId(input.accountId, input.actorUserId, deal, conversationId)
        const sent = await engineSendText({ accountId: input.accountId, userId, conversationId, contactId: input.contactId, text })
        const now = new Date()
        await db.update(conversations).set({ lastFollowUpAt: now.toISOString() }).where(eq(conversations.id, conversationId))
        if (deal) {
          await db
            .update(deals)
            .set({ nextFollowUpAt: new Date(now.getTime() + FOLLOW_UP_NEXT_HOURS * 3_600_000).toISOString(), updatedAt: now.toISOString() })
            .where(eq(deals.id, deal.id))
        }
        return { ok: true, result: { messageId: sent.whatsapp_message_id, conversationId, nextFollowUpHours: deal ? FOLLOW_UP_NEXT_HOURS : null } }
      }

      case 'move_deal': {
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        let stageId = typeof input.payload.stageId === 'string' ? input.payload.stageId : null
        const stageName = typeof input.payload.stageName === 'string' ? input.payload.stageName.trim() : ''
        const stages = await db
          .select({ id: pipelineStages.id, name: pipelineStages.name, position: pipelineStages.position })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, deal.pipelineId))
        if (!stageId && stageName) {
          stageId = stages.find((s) => s.name.trim().toLowerCase() === stageName.toLowerCase())?.id ?? null
        }
        if (!stageId && input.payload.direction === 'next') {
          const sorted = [...stages].sort((a, b) => a.position - b.position)
          const idx = sorted.findIndex((s) => s.id === deal.stageId)
          stageId = idx >= 0 && sorted[idx + 1] ? sorted[idx + 1].id : null
        }
        const to = stages.find((s) => s.id === stageId)
        if (!stageId || !to) return { ok: false, error: 'Etapa de destino não encontrada no funil do negócio.' }
        if (stageId === deal.stageId) return { ok: true, result: { unchanged: true } }
        const from = stages.find((s) => s.id === deal.stageId)
        const now = new Date().toISOString()
        await db.update(deals).set({ stageId, stageChangedAt: now, updatedAt: now }).where(eq(deals.id, deal.id))
        await db.insert(dealEvents).values({
          accountId: input.accountId,
          actorUserId: input.actorUserId,
          dealId: deal.id,
          type: 'stage_changed',
          data: { from: from?.name ?? null, to: to.name, fromId: deal.stageId, toId: stageId, by: input.actorUserId ? 'human' : 'ai' },
        })
        try {
          await autoCreateStageTasks({ accountId: input.accountId, userId: input.actorUserId }, deal.id, stageId)
        } catch (err) {
          console.error('[orchestration] tarefas da etapa falharam:', err instanceof Error ? err.message : err)
        }
        try {
          if (deal.conversationId) await planStageFollowUp({ accountId: input.accountId, conversationId: deal.conversationId, stageName: to.name, dealId: deal.id })
        } catch (err) {
          console.error('[orchestration] planStageFollowUp falhou:', err instanceof Error ? err.message : err)
        }
        return { ok: true, result: { fromStage: from?.name ?? null, toStage: to.name, stageId } }
      }

      case 'create_task': {
        const title = typeof input.payload.title === 'string' && input.payload.title.trim() ? input.payload.title.trim().slice(0, 200) : `Falar com o cliente${deal?.title ? ` · ${deal.title}` : ''}`
        const dueRaw = typeof input.payload.dueAt === 'string' ? new Date(input.payload.dueAt) : null
        const dueAt = dueRaw && !Number.isNaN(dueRaw.getTime()) ? dueRaw : new Date(Date.now() + 24 * 3_600_000)
        const assignee = deal?.assignedTo ?? null
        const [row] = await db
          .insert(tasks)
          .values({
            accountId: input.accountId,
            title,
            description: input.reason,
            dueAt: dueAt.toISOString(),
            status: 'open',
            type: 'followup',
            contactId: input.contactId,
            dealId: deal?.id ?? null,
            assignedTo: assignee,
            assigneeIds: assignee ? [assignee] : [],
            createdBy: input.actorUserId,
          })
          .returning({ id: tasks.id })
        if (assignee) {
          await notifyUsers({
            accountId: input.accountId,
            userIds: [assignee],
            type: 'task_assigned',
            title: `Tarefa da Fluxia: ${title}`,
            body: input.reason,
            contactId: input.contactId,
            dealId: deal?.id ?? null,
          })
        }
        return { ok: true, result: { taskId: row?.id ?? null, assignedTo: assignee } }
      }

      case 'update_follow_up': {
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        const at = typeof input.payload.at === 'string' ? new Date(input.payload.at) : new Date(Date.now() + FOLLOW_UP_NEXT_HOURS * 3_600_000)
        if (Number.isNaN(at.getTime())) return { ok: false, error: 'Data inválida.' }
        await db.update(deals).set({ nextFollowUpAt: at.toISOString(), updatedAt: new Date().toISOString() }).where(eq(deals.id, deal.id))
        return { ok: true, result: { nextFollowUpAt: at.toISOString() } }
      }

      case 'notify_seller':
      case 'notify_owner':
      case 'escalate': {
        let userIds: string[] = []
        if (input.action === 'notify_seller') {
          if (deal?.assignedTo) userIds = [deal.assignedTo]
          else if (input.conversationId) {
            const c = firstOrNull(await db.select({ a: conversations.assignedAgentId }).from(conversations).where(eq(conversations.id, input.conversationId)).limit(1))
            if (c?.a) userIds = [c.a]
          }
        }
        if (userIds.length === 0) userIds = await adminUserIds(input.accountId)
        if (input.action === 'escalate' && input.conversationId) {
          await db.update(conversations).set({ aiAutoreplyDisabled: true }).where(eq(conversations.id, input.conversationId))
        }
        const title = typeof input.payload.title === 'string' && input.payload.title.trim() ? input.payload.title.trim() : input.action === 'escalate' ? 'Fluxia escalou pra você' : 'Fluxia: atenção neste cliente'
        const n = await notifyUsers({
          accountId: input.accountId,
          userIds,
          type: 'agent_action',
          title,
          body: input.reason,
          contactId: input.contactId,
          dealId: deal?.id ?? null,
          conversationId: input.conversationId,
        })
        return { ok: true, result: { notified: n, aiPaused: input.action === 'escalate' } }
      }

      case 'draft_proposal': {
        // Monta a proposta SALVA do negócio (nada sai pro cliente) — é o passo
        // que faltava: "enviar proposta" travava porque não existia proposta.
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        const already = firstOrNull(
          await db.select({ id: dealProposals.id }).from(dealProposals).where(eq(dealProposals.dealId, deal.id)).limit(1),
        )
        if (already) return { ok: true, result: { proposalId: already.id, alreadyExisted: true } }
        const items = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(dealProducts)
          .where(eq(dealProducts.dealId, deal.id))
        const itemCount = items[0]?.n ?? 0
        const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
        const [row] = await db
          .insert(dealProposals)
          .values({ dealId: deal.id, accountId: input.accountId, discount: '0', discountType: 'value', validUntil, terms: null })
          .returning({ id: dealProposals.id })
        return {
          ok: true,
          result: {
            proposalId: row?.id ?? null,
            items: itemCount,
            // Sem produtos lançados a proposta nasce vazia — quem revisar precisa saber.
            note: itemCount === 0 ? 'Sem produtos no negócio: adicione os itens na aba Produtos antes de enviar.' : null,
          },
        }
      }

      case 'apply_discount': {
        // Só GRAVA na proposta salva (nada sai pro cliente). Acima do limite a
        // política já mandou pra aprovação antes de chegar aqui.
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        const pct = Number(input.payload.discountPct)
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: 'Desconto inválido.' }
        const prop = firstOrNull(
          await db
            .select({ id: dealProposals.id, acceptedAt: dealProposals.acceptedAt })
            .from(dealProposals)
            .where(eq(dealProposals.dealId, deal.id))
            .limit(1),
        )
        if (!prop) return { ok: false, error: 'Não há proposta salva neste negócio.' }
        if (prop.acceptedAt) return { ok: false, error: 'A proposta já foi aceita — não dá pra mexer no desconto.' }
        await db
          .update(dealProposals)
          .set({ discount: String(pct), discountType: 'percent', updatedAt: new Date().toISOString() })
          .where(eq(dealProposals.id, prop.id))
        return { ok: true, result: { proposalId: prop.id, discountPct: pct } }
      }

      case 'start_cadence': {
        const cadenceId =
          typeof input.payload.cadenceId === 'string' && input.payload.cadenceId
            ? input.payload.cadenceId
            : typeof input.payload.staleCadenceId === 'string'
              ? input.payload.staleCadenceId
              : null
        if (!cadenceId) return { ok: false, error: 'Sem cadência escolhida.' }
        const userId = await senderUserId(input.accountId, input.actorUserId, deal, input.conversationId)
        const r = await enrollContactInCadence(
          { accountId: input.accountId, userId },
          { cadenceId, contactId: input.contactId, conversationId: input.conversationId, dealId: deal?.id ?? null },
        )
        if (!r.ok) return { ok: false, error: r.error ?? 'Não foi possível iniciar a cadência.' }
        return { ok: true, result: { enrollmentId: r.enrollmentId ?? null, scheduled: r.scheduled ?? 0 } }
      }

      case 'pause_cadence': {
        const enr = firstOrNull(
          await db
            .select({ id: cadenceEnrollments.id })
            .from(cadenceEnrollments)
            .where(
              and(
                eq(cadenceEnrollments.accountId, input.accountId),
                eq(cadenceEnrollments.contactId, input.contactId),
                eq(cadenceEnrollments.status, 'active'),
                deal ? eq(cadenceEnrollments.dealId, deal.id) : isNull(cadenceEnrollments.dealId),
              ),
            )
            .orderBy(desc(cadenceEnrollments.enrolledAt))
            .limit(1),
        )
        if (!enr) return { ok: true, result: { nothingToPause: true } }
        const ok = await cancelEnrollment(input.accountId, enr.id)
        return { ok, result: { enrollmentId: enr.id }, error: ok ? undefined : 'Não foi possível pausar a cadência.' }
      }

      default:
        return { ok: false, error: `Ação ${input.action} não suportada.` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

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
  contacts,
  conversations,
  dealEvents,
  deals,
  member,
  notifications,
  pipelineStages,
  tasks,
  asaasCharges,
  collectionsTouches,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { cancelEnrollment, enrollContactInCadence } from '@/lib/cadences/cadence'
import { publishEvent } from '@/lib/events/publish'
import { engineSendText } from '@/lib/flows/meta-send'
import { resolveCollectionTargets } from '@/lib/collections/outreach'
import { reminderStillPending } from '@/lib/collections/reminders'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
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
  /** Estado ANTERIOR à execução — o que o "Desfazer" precisa restaurar.
   *  Ausente = ação sem reversão possível (ex.: mensagem entregue). */
  revertState?: Record<string, unknown>
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
        value: deals.value,
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

/**
 * Atribui as conversas de cobrança a quem cuida das respostas
 * (`collections.assigneeUserId`). Sempre que a cobrança sai: o dono decidiu
 * que cobrança é dessa pessoa, então até conversa já atribuída a outro passa
 * pra ela (a resposta "já paguei" tem que cair com quem resolve). Sem a
 * configuração, não mexe em nada. Nunca derruba o envio: falha aqui é log.
 */
async function assignCollectionConversations(accountId: string, conversationIds: Array<string | null>): Promise<void> {
  try {
    const { getAccountSettings } = await import('@/lib/settings/account-settings')
    const { normalizeSettings } = await import('@/lib/collections/rules')
    const s = normalizeSettings((await getAccountSettings(accountId)).collections)
    if (!s.assigneeUserId && !s.sectorId) return
    const ids = conversationIds.filter((id): id is string => !!id)
    if (!ids.length) return
    const now = new Date().toISOString()
    const patch: { assignedAgentId?: string; assignedAt?: string; sectorId?: string; updatedAt: string } = { updatedAt: now }
    if (s.assigneeUserId) {
      const { member: memberTable } = await import('@/db')
      const stillMember = await db
        .select({ id: memberTable.id })
        .from(memberTable)
        .where(and(eq(memberTable.organizationId, accountId), eq(memberTable.userId, s.assigneeUserId)))
        .limit(1)
      if (stillMember.length) {
        patch.assignedAgentId = s.assigneeUserId
        patch.assignedAt = now
      }
    }
    // 🗂️ Setor das conversas de cobrança (João/GoLink 10/09: "cai na caixinha
    // Asaas, pra não misturar"). Só se o setor ainda existe nesta conta.
    if (s.sectorId) {
      const { sectors: sectorsTable } = await import('@/db')
      const sector = await db
        .select({ id: sectorsTable.id })
        .from(sectorsTable)
        .where(and(eq(sectorsTable.accountId, accountId), eq(sectorsTable.id, s.sectorId)))
        .limit(1)
      if (sector.length) patch.sectorId = s.sectorId
    }
    if (!patch.assignedAgentId && !patch.sectorId) return
    await db
      .update(conversations)
      .set(patch)
      .where(and(eq(conversations.accountId, accountId), inArray(conversations.id, ids)))
  } catch (err) {
    console.error('[cobranca] não deu pra atribuir a conversa a quem cuida das respostas:', err instanceof Error ? err.message : err)
  }
}

export async function executeOrchestrationAction(input: ExecInput): Promise<ExecResult> {
  const meta = ACTION_CATALOG[input.action]
  if (meta.humanOnly) return { ok: false, needsHuman: true, error: 'Esta ação só o humano executa (aprove na fila "Precisa de você").' }

  const deal = input.dealId ? await loadDeal(input.accountId, input.dealId) : null
  if (input.dealId && !deal) return { ok: false, error: 'Negócio não encontrado.' }

  try {
    switch (input.action) {
      // 🧾 A cobrança da régua: UMA mensagem por devedor com todas as parcelas
      // vencidas dele. Antes de mandar, reconsulta o que está em aberto AGORA —
      // é a última trava contra cobrar quem acabou de pagar, e ela vale mesmo
      // que o webhook do Asaas (Fase 4) tenha falhado ou atrasado.
      case 'collect_charges': {
        const text = (input.text ?? '').trim()
        if (!text) return { ok: false, error: 'Sem texto pra enviar.' }

        // 🔔 Lembrete antes do vencimento (payload.kind='reminder'): a parcela
        // não está na carteira de vencidas — reconfere AO VIVO no Asaas.
        const isReminder = input.payload.kind === 'reminder'
        if (isReminder) {
          const check = await reminderStillPending(input.accountId, input.payload)
          if (!check.ok) return { ok: false, error: check.error }
        } else {
          const stillOpen = await db
            .select({ id: asaasCharges.id })
            .from(asaasCharges)
            .where(and(eq(asaasCharges.accountId, input.accountId), eq(asaasCharges.contactId, input.contactId), eq(asaasCharges.open, true)))
            .limit(1)
          if (!stillOpen.length) {
            return { ok: false, error: 'Este cliente não tem mais nada em aberto — a cobrança não foi enviada.' }
          }
        }

        // Por onde sai (auto / whatsapp / email / both) e em que conversa — abre
        // a conversa sozinha para quem nunca escreveu (item 1) e manda por
        // e-mail quando é o caso (item 3). Toda recusa explica o que resolver.
        const targets = await resolveCollectionTargets(input.accountId, input.contactId, input.conversationId ?? deal?.conversationId ?? null)
        if (!targets.ok) return { ok: false, error: targets.error }
        const conversationId = targets.whatsapp?.conversationId ?? targets.email!.conversationId
        const userId = await senderUserId(input.accountId, input.actorUserId, deal, conversationId)

        const sentVia: string[] = []
        let waMessageId: string | null = null
        if (targets.whatsapp) {
          const sent = await engineSendText({ accountId: input.accountId, userId, conversationId: targets.whatsapp.conversationId, contactId: input.contactId, text })
          waMessageId = sent.whatsapp_message_id
          sentVia.push('whatsapp')
        }
        let emailError: string | null = null
        if (targets.email) {
          try {
            await sendMessageToConversation(input.accountId, {
              conversationId: targets.email.conversationId,
              messageType: 'text',
              contentText: collectionEmailBody(text, input.payload),
              subject: collectionEmailSubject(input.payload),
            })
            sentVia.push('email')
          } catch (err) {
            emailError = err instanceof Error ? err.message : 'falha ao enviar o e-mail'
            // Só e-mail e ele falhou → a ação falhou. WhatsApp já saiu → registra e segue.
            if (!sentVia.length) return { ok: false, error: `O e-mail não saiu: ${emailError}` }
          }
        }
        // 👤 Quem cuida das respostas (Ajustar → "Quem cuida das respostas"):
        // a conversa onde a cobrança saiu passa a ser dessa pessoa — ela vê na
        // lista dela e recebe a resposta do cliente (10/09, Leonardo/GoLink).
        await assignCollectionConversations(input.accountId, [targets.whatsapp?.conversationId ?? null, targets.email?.conversationId ?? null])

        // Lembrete não conta como toque de cobrança: não mexe no ritmo da régua
        // nem no contador que devolve o devedor para uma pessoa.
        if (!isReminder) {
        const nowIso = new Date().toISOString()

        await db
          .insert(collectionsTouches)
          .values({ accountId: input.accountId, contactId: input.contactId, lastTouchAt: nowIso, touchCount: 1, updatedAt: nowIso, recentTexts: [text] })
          .onConflictDoUpdate({
            target: [collectionsTouches.accountId, collectionsTouches.contactId],
            set: { lastTouchAt: nowIso, touchCount: sql`${collectionsTouches.touchCount} + 1`, updatedAt: nowIso },
          })
        // Guarda o que FOI enviado (não o rascunho): é o que a IA recebe no
        // próximo toque como "não repita isto". Últimas 3, mais recente primeiro.
        const prevTexts = firstOrNull(
          await db
            .select({ recentTexts: collectionsTouches.recentTexts })
            .from(collectionsTouches)
            .where(and(eq(collectionsTouches.accountId, input.accountId), eq(collectionsTouches.contactId, input.contactId)))
            .limit(1),
        )
        const kept = [text, ...(Array.isArray(prevTexts?.recentTexts) ? prevTexts.recentTexts : []).filter((t) => typeof t === 'string' && t !== text)].slice(0, 3)
        await db
          .update(collectionsTouches)
          .set({ recentTexts: kept })
          .where(and(eq(collectionsTouches.accountId, input.accountId), eq(collectionsTouches.contactId, input.contactId)))
        }

        return {
          ok: true,
          result: { messageId: waMessageId, conversationId, sentVia, label: targets.label, ...(emailError ? { emailError } : {}) },
          // A mensagem não volta; guardamos o devedor para que "Corrigir"
          // consiga parar a régua nele além de pausar a IA na conversa.
          revertState: { contactId: input.contactId, conversationId },
        }
      }

      case 'schedule_event': {
        // 📅 Aprovado em Precisa de você: marca na Agenda e confirma o horário
        // pro cliente na conversa (a IA tinha dito que ia confirmar).
        const p = input.payload as { startsLocal?: string; title?: string; timezone?: string; durationMin?: number }
        if (!p.startsLocal) return { ok: false, error: 'Sem data/hora no pedido.' }
        if (!input.conversationId) return { ok: false, error: 'Sem conversa pra confirmar ao cliente.' }
        const tz = p.timezone || 'America/Sao_Paulo'
        const { scheduleEventFromAi } = await import('@/lib/ai/schedule-actions')
        const ev = await scheduleEventFromAi({
          accountId: input.accountId,
          userId: input.actorUserId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          startsLocal: p.startsLocal,
          title: p.title || 'Reunião',
          timezone: tz,
          durationMin: p.durationMin,
        })
        if (!ev) return { ok: false, error: 'Não consegui marcar (data/hora inválida ou agenda indisponível).' }
        const when = new Date(ev.startsAt)
          .toLocaleString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
          .replace('.,', '')
        let confirmed = false
        try {
          const userId = await senderUserId(input.accountId, input.actorUserId, deal, input.conversationId)
          await engineSendText({
            accountId: input.accountId,
            userId,
            conversationId: input.conversationId,
            contactId: input.contactId,
            text: `Confirmado! ✅ ${ev.title}: ${when}. Até lá!`,
          })
          confirmed = true
        } catch (err) {
          console.error('[orchestration] confirmação do agendamento falhou:', err instanceof Error ? err.message : err)
        }
        try {
          const { postInternalNote } = await import('@/lib/ai/close-actions')
          await postInternalNote({
            conversationId: input.conversationId,
            text: `📅 Aprovado: "${ev.title}" marcado para ${when}${confirmed ? ' e confirmado pro cliente.' : '. A confirmação ao cliente FALHOU — mande você.'}`,
          })
        } catch {
          /* nota é rastro */
        }
        return {
          ok: true,
          result: { eventId: ev.eventId, startsAt: ev.startsAt, title: ev.title, confirmed },
          revertState: { eventId: ev.eventId, conversationId: input.conversationId },
        }
      }
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
        return {
          ok: true,
          result: { fromStage: from?.name ?? null, toStage: to.name, stageId },
          revertState: { stageId: deal.stageId, stageName: from?.name ?? null },
        }
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
        return { ok: true, result: { taskId: row?.id ?? null, assignedTo: assignee }, revertState: { taskId: row?.id ?? null } }
      }

      case 'update_follow_up': {
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        const at = typeof input.payload.at === 'string' ? new Date(input.payload.at) : new Date(Date.now() + FOLLOW_UP_NEXT_HOURS * 3_600_000)
        if (Number.isNaN(at.getTime())) return { ok: false, error: 'Data inválida.' }
        const antes = firstOrNull(await db.select({ v: deals.nextFollowUpAt }).from(deals).where(eq(deals.id, deal.id)).limit(1))
        await db.update(deals).set({ nextFollowUpAt: at.toISOString(), updatedAt: new Date().toISOString() }).where(eq(deals.id, deal.id))
        return { ok: true, result: { nextFollowUpAt: at.toISOString() }, revertState: { nextFollowUpAt: antes?.v ?? null } }
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
        // ⚠️ 04/09: o título era "Fluxia: atenção neste cliente" — sem dizer QUAL
        // cliente. Numa lista de 20 notificações isso é indistinguível.
        const quem = firstOrNull(
          await db.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1),
        )
        const nome = (quem?.name || quem?.phone || '').trim()
        const title =
          typeof input.payload.title === 'string' && input.payload.title.trim()
            ? input.payload.title.trim()
            : input.action === 'escalate'
              ? nome ? `Fluxia escalou pra você — ${nome}` : 'Fluxia escalou pra você'
              : nome ? `Atenção neste cliente — ${nome}` : 'Fluxia: atenção neste cliente'
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
        // Monta a proposta SALVA do negócio (nada sai pro cliente).
        // ⚠️ 03/09: a v1 criava a proposta VAZIA → página pública com R$ 0,00 e
        // botão "Aceitar" (o Alex aprovou pra ver e virou uma proposta zerada).
        // Agora: sem itens lançados, a proposta nasce com UM item = título do
        // negócio × o valor (o da fila, editável, ou o valor do negócio). Sem
        // valor nenhum, RECUSA — melhor não montar do que montar R$ 0.
        if (!deal) return { ok: false, error: 'Ação precisa de um negócio.' }
        const already = firstOrNull(
          await db.select({ id: dealProposals.id }).from(dealProposals).where(eq(dealProposals.dealId, deal.id)).limit(1),
        )
        if (already) return { ok: true, result: { proposalId: already.id, alreadyExisted: true } }

        const existingItems = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(dealProducts)
          .where(eq(dealProducts.dealId, deal.id))
        const itemCount = existingItems[0]?.n ?? 0

        // Valor: o que veio da fila (humano editou) → senão o valor do negócio.
        const askedRaw = Number(input.payload.proposalValue)
        const dealValue = Number(deal.value ?? 0)
        const value = Number.isFinite(askedRaw) && askedRaw > 0 ? askedRaw : dealValue
        if (itemCount === 0 && !(value > 0)) {
          return {
            ok: false,
            error: 'O negócio não tem produtos nem valor — defina o valor do negócio (ou lance os itens na aba Produtos) antes de montar a proposta.',
          }
        }

        const validUntil = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
        const [row] = await db
          .insert(dealProposals)
          .values({ dealId: deal.id, accountId: input.accountId, discount: '0', discountType: 'value', validUntil, terms: null })
          .returning({ id: dealProposals.id })

        let createdItem: string | null = null
        if (itemCount === 0) {
          createdItem = deal.title || 'Serviço'
          await db.insert(dealProducts).values({
            accountId: input.accountId,
            dealId: deal.id,
            name: createdItem,
            quantity: '1',
            unitPrice: value.toFixed(2),
          })
          // O valor do negócio acompanha o da proposta quando estava zerado.
          if (!(dealValue > 0)) {
            await db.update(deals).set({ value: value.toFixed(2), updatedAt: new Date().toISOString() }).where(eq(deals.id, deal.id))
          }
        }
        return {
          ok: true,
          result: { proposalId: row?.id ?? null, items: itemCount || 1, createdItem, value: itemCount === 0 ? value : null },
          // desfazer = apagar a proposta (e o item que a IA lançou), só se não aceita
          revertState: { proposalId: row?.id ?? null, createdItemForDeal: itemCount === 0 ? deal.id : null },
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
        const antesDesc = firstOrNull(
          await db.select({ d: dealProposals.discount, dt: dealProposals.discountType }).from(dealProposals).where(eq(dealProposals.id, prop.id)).limit(1),
        )
        await db
          .update(dealProposals)
          .set({ discount: String(pct), discountType: 'percent', updatedAt: new Date().toISOString() })
          .where(eq(dealProposals.id, prop.id))
        return {
          ok: true,
          result: { proposalId: prop.id, discountPct: pct },
          revertState: { proposalId: prop.id, discount: antesDesc?.d ?? '0', discountType: antesDesc?.dt ?? 'value' },
        }
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
        return {
          ok: true,
          result: { enrollmentId: r.enrollmentId ?? null, scheduled: r.scheduled ?? 0 },
          revertState: { enrollmentId: r.enrollmentId ?? null },
        }
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

// ------------------------------------------------ cobrança por e-mail (item 3)

/** Assunto curto: o toque nº N já diz que é a 2ª/3ª vez. */
function collectionEmailSubject(payload: Record<string, unknown>): string {
  const touch = Number(payload.touch ?? 1)
  return touch > 1 ? `Lembrete de pagamento em aberto (${touch}º aviso)` : 'Lembrete de pagamento em aberto'
}

/** O texto redigido + os links, quando há mais de um (no texto só cabe um). */
function collectionEmailBody(text: string, payload: Record<string, unknown>): string {
  const links = Array.isArray(payload.links) ? payload.links.filter((l): l is string => typeof l === 'string' && l.length > 0) : []
  if (links.length <= 1) return text
  return `${text}\n\nLinks para pagamento:\n${links.map((l) => `- ${l}`).join('\n')}`
}

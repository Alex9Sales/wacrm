'use server'

// ============================================================
// "Precisa de você" — fila ÚNICA das ações da IA que exigem aprovação
// (todos os tipos: follow-up, reativação, proposta, desconto, fechar, mover…).
// Aprovar executa a ação COM o usuário que aprovou (auditoria: resolved_by).
// Ações "só humano" rodam pelas Server Actions do app (efeitos completos).
// Erros esperados voltam como { ok:false, error } (throw vira "digest" em prod).
// ============================================================

import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import { db, agentActionRequests, channels, contacts, conversations, customerSignals, dealProducts, dealProposals, deals, pipelineStages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { executeOrchestrationAction, noteDealEvent } from '@/lib/orchestration/actions'
import { ACTION_CATALOG, type OrchAction, type Risk } from '@/lib/orchestration/policy'
import { loadDealProposalFields } from '@/lib/proposals/proposal'
import { saveDealProposal, sendDealProposalEmail, setDealStatus } from '@/app/(dashboard)/pipelines/actions'

export interface ApprovalItem {
  id: string
  action: OrchAction
  actionLabel: string
  actionHint: string
  risk: Risk
  isMessage: boolean
  humanOnly: boolean
  contact: { id: string; name: string | null; phone: string | null }
  deal: { id: string; title: string; value: string; stageName: string | null } | null
  conversationId: string | null
  suggestedText: string | null
  reason: string | null
  policy: string | null
  payload: Record<string, unknown>
  error: string | null
  attempts: number
  createdAt: string
  /** O que a Fluxia vai fazer se aprovar (em português, concreto). */
  effect: string
  /** Pré-requisitos que faltam (aprovar vai falhar). */
  warnings: string[]
  /** Link da proposta salva (pública), quando houver. */
  proposalUrl: string | null
  contactEmail: string | null
  /** Conversas do contato por onde a mensagem PODE sair (ações de mensagem). */
  sendOptions: { conversationId: string; label: string }[]
  /** A conversa que será usada se não trocar (a do negócio, senão a mais recente). */
  defaultConversationId: string | null
}

export interface AutonomyMetrics {
  days: number
  pending: number
  autoExecuted: number
  approved: number
  rejected: number
  blocked: number
  failed: number
  /** aprovadas / (aprovadas + recusadas), 0–100 */
  approvalRate: number
  /** % das ações executadas (auto + aprovadas) que foram automáticas */
  autoShare: number
}

export type ActionResult = { ok: true } | { ok: false; error: string }

function isOrchAction(v: string): v is OrchAction {
  return Object.prototype.hasOwnProperty.call(ACTION_CATALOG, v)
}

/** Fila pendente da conta (todas as ações), mais antigas primeiro. */
export async function listApprovalQueue(): Promise<ApprovalItem[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: agentActionRequests.id,
      actionType: agentActionRequests.actionType,
      contactId: agentActionRequests.contactId,
      dealId: agentActionRequests.dealId,
      conversationId: agentActionRequests.conversationId,
      suggestedText: agentActionRequests.suggestedText,
      reason: agentActionRequests.reason,
      policy: agentActionRequests.policy,
      payload: agentActionRequests.payload,
      error: agentActionRequests.error,
      attempts: agentActionRequests.attempts,
      createdAt: agentActionRequests.createdAt,
      contactName: contacts.name,
      contactPhone: contacts.phone,
      contactEmail: contacts.email,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .where(and(eq(agentActionRequests.accountId, ctx.accountId), eq(agentActionRequests.status, 'pending')))
    .orderBy(desc(agentActionRequests.createdAt))
    .limit(200)

  const dealIds = Array.from(new Set(rows.map((r) => r.dealId).filter((x): x is string => !!x)))
  const dealMap = new Map<string, { id: string; title: string; value: string; stageName: string | null }>()
  if (dealIds.length) {
    const ds = await db
      .select({ id: deals.id, title: deals.title, value: deals.value, stageName: pipelineStages.name })
      .from(deals)
      .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.accountId, ctx.accountId), inArray(deals.id, dealIds)))
    for (const d of ds) dealMap.set(d.id, { id: d.id, title: d.title, value: String(d.value ?? '0'), stageName: d.stageName ?? null })
  }

  // Conversa vinculada ao negócio (define o canal padrão do envio).
  const dealConvByDeal = new Map<string, string | null>()
  if (dealIds.length) {
    const dc = await db
      .select({ id: deals.id, conversationId: deals.conversationId })
      .from(deals)
      .where(and(eq(deals.accountId, ctx.accountId), inArray(deals.id, dealIds)))
    for (const d of dc) dealConvByDeal.set(d.id, d.conversationId ?? null)
  }

  // Conversas do contato + canal (pro seletor "por onde enviar" das ações de mensagem).
  const msgContactIds = Array.from(
    new Set(
      rows
        .filter((r) => isOrchAction(r.actionType) && ACTION_CATALOG[r.actionType as OrchAction].kind === 'message')
        .map((r) => r.contactId),
    ),
  )
  const convsByContact = new Map<string, { conversationId: string; label: string }[]>()
  if (msgContactIds.length) {
    const convs = await db
      .select({
        id: conversations.id,
        contactId: conversations.contactId,
        channelName: channels.name,
        provider: channels.provider,
      })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.accountId, ctx.accountId), inArray(conversations.contactId, msgContactIds)))
      .orderBy(desc(conversations.lastMessageAt))
    for (const c of convs) {
      const list = convsByContact.get(c.contactId) ?? []
      list.push({ conversationId: c.id, label: channelLabel(c.provider, c.channelName) })
      convsByContact.set(c.contactId, list)
    }
  }

  // Apoio pro "o que acontece ao aprovar": proposta salva + itens (send_proposal), etapas (move_deal).
  const proposalByDeal = new Map<string, { id: string; acceptedAt: string | null }>()
  const itemsByDeal = new Map<string, number>()
  if (dealIds.length) {
    const props = await db.select({ id: dealProposals.id, dealId: dealProposals.dealId, acceptedAt: dealProposals.acceptedAt }).from(dealProposals).where(inArray(dealProposals.dealId, dealIds))
    for (const pr of props) proposalByDeal.set(pr.dealId, { id: pr.id, acceptedAt: pr.acceptedAt })
    const items = await db
      .select({ dealId: dealProducts.dealId, n: sql<number>`count(*)::int` })
      .from(dealProducts)
      .where(inArray(dealProducts.dealId, dealIds))
      .groupBy(dealProducts.dealId)
    for (const it of items) itemsByDeal.set(it.dealId, it.n)
  }

  return rows
    .filter((r) => isOrchAction(r.actionType))
    .map((r) => {
      const meta = ACTION_CATALOG[r.actionType as OrchAction]
      const deal = r.dealId ? (dealMap.get(r.dealId) ?? { id: r.dealId, title: 'Negócio', value: '0', stageName: null }) : null
      const { effect, warnings, proposalUrl } = describeEffect({
        action: r.actionType as OrchAction,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        dealTitle: deal?.title ?? null,
        contactEmail: r.contactEmail ?? null,
        proposal: r.dealId ? (proposalByDeal.get(r.dealId) ?? null) : null,
        items: r.dealId ? (itemsByDeal.get(r.dealId) ?? 0) : 0,
      })
      const isMessage = meta.kind === 'message'
      const sendOptions = isMessage ? (convsByContact.get(r.contactId) ?? []) : []
      const dealConv = r.dealId ? (dealConvByDeal.get(r.dealId) ?? null) : null
      const preferred = r.conversationId ?? dealConv
      const defaultConversationId = isMessage
        ? (sendOptions.find((o) => o.conversationId === preferred)?.conversationId ?? sendOptions[0]?.conversationId ?? null)
        : null
      if (isMessage && sendOptions.length === 0) {
        warnings.push('O contato não tem conversa aberta em nenhum canal — não dá pra enviar. Abra uma conversa com ele primeiro.')
      }
      return {
        effect,
        warnings,
        proposalUrl,
        contactEmail: r.contactEmail ?? null,
        sendOptions,
        defaultConversationId,
        id: r.id,
        action: r.actionType as OrchAction,
        actionLabel: meta.label,
        actionHint: meta.hint,
        risk: meta.risk,
        isMessage: meta.kind === 'message',
        humanOnly: !!meta.humanOnly,
        contact: { id: r.contactId, name: r.contactName ?? null, phone: r.contactPhone ?? null },
        deal: r.dealId ? (dealMap.get(r.dealId) ?? { id: r.dealId, title: 'Negócio', value: '0', stageName: null }) : null,
        conversationId: r.conversationId,
        suggestedText: r.suggestedText,
        reason: r.reason,
        policy: r.policy,
        payload: (r.payload ?? {}) as Record<string, unknown>,
        error: r.error,
        attempts: r.attempts,
        createdAt: r.createdAt,
      }
    })
}

/** Métricas de autonomia da conta nos últimos N dias. */
export async function getAutonomyMetrics(days = 7): Promise<AutonomyMetrics> {
  const ctx = await getCurrentAccount()
  const since = new Date(Date.now() - Math.max(1, Math.min(90, days)) * 86_400_000).toISOString()
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'pending')::int`,
      auto: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is null and ${agentActionRequests.createdAt} >= ${since})::int`,
      approved: sql<number>`count(*) filter (where ${agentActionRequests.status} in ('sent','done') and ${agentActionRequests.resolvedBy} is not null and ${agentActionRequests.createdAt} >= ${since})::int`,
      rejected: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'rejected' and ${agentActionRequests.createdAt} >= ${since})::int`,
      blocked: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'blocked' and ${agentActionRequests.createdAt} >= ${since})::int`,
      failed: sql<number>`count(*) filter (where ${agentActionRequests.status} = 'failed' and ${agentActionRequests.createdAt} >= ${since})::int`,
    })
    .from(agentActionRequests)
    .where(eq(agentActionRequests.accountId, ctx.accountId))
  const approved = row?.approved ?? 0
  const rejected = row?.rejected ?? 0
  const auto = row?.auto ?? 0
  return {
    days,
    pending: row?.pending ?? 0,
    autoExecuted: auto,
    approved,
    rejected,
    blocked: row?.blocked ?? 0,
    failed: row?.failed ?? 0,
    approvalRate: approved + rejected > 0 ? Math.round((approved / (approved + rejected)) * 100) : 0,
    autoShare: auto + approved > 0 ? Math.round((auto / (auto + approved)) * 100) : 0,
  }
}

async function loadPending(accountId: string, id: string) {
  return firstOrNull(
    await db
      .select()
      .from(agentActionRequests)
      .where(and(eq(agentActionRequests.id, id), eq(agentActionRequests.accountId, accountId), eq(agentActionRequests.status, 'pending')))
      .limit(1),
  )
}

/** Aprova (e executa) um item. `text` = mensagem editada, se for ação de mensagem. */
export async function approveQueueItem(input: { id: string; text?: string | null; payload?: Record<string, unknown>; conversationId?: string | null }): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = await loadPending(ctx.accountId, input.id)
  if (!row) return { ok: false, error: 'Este pedido não está mais pendente.' }
  if (!isOrchAction(row.actionType)) return { ok: false, error: 'Tipo de ação desconhecido.' }
  const action = row.actionType
  const meta = ACTION_CATALOG[action]
  const payload = { ...((row.payload ?? {}) as Record<string, unknown>), ...(input.payload ?? {}) }
  const text = meta.kind === 'message' ? (input.text ?? row.suggestedText ?? '').trim() : null
  if (meta.kind === 'message' && !text) return { ok: false, error: 'Escreva a mensagem antes de aprovar.' }
  // Canal escolhido na fila: só aceita conversa DESTE contato, desta conta.
  let sendConversationId = row.conversationId
  if (meta.kind === 'message' && input.conversationId) {
    const conv = firstOrNull(
      await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.accountId, ctx.accountId), eq(conversations.contactId, row.contactId)))
        .limit(1),
    )
    if (!conv) return { ok: false, error: 'A conversa escolhida não é deste contato.' }
    sendConversationId = conv.id
  }

  let result: Record<string, unknown> = {}
  let error: string | null = null
  if (meta.humanOnly) {
    if (!row.dealId) error = 'Esta ação precisa de um negócio.'
    else if (action === 'send_proposal') {
      const r = await sendDealProposalEmail(row.dealId)
      error = r.error
      result = { sentProposal: !r.error }
    } else if (action === 'apply_discount') {
      const pct = Number(payload.discountPct)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) error = 'Desconto inválido.'
      else {
        const cur = await loadDealProposalFields(ctx.accountId, row.dealId)
        const r = await saveDealProposal(row.dealId, { discount: pct, discountType: 'percent', validUntil: cur.fields.validUntil, terms: cur.fields.terms })
        error = r.error
        result = { discountPct: pct, proposalId: r.id }
      }
    } else if (action === 'close_deal') {
      const status = payload.status === 'won' ? 'won' : 'lost'
      const r = await setDealStatus(row.dealId, status, typeof payload.reason === 'string' ? payload.reason : null)
      error = r.error
      result = { status }
    } else error = 'Ação só-humano não mapeada.'
  } else {
    const r = await executeOrchestrationAction({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      agentId: row.agentId,
      action,
      contactId: row.contactId,
      dealId: row.dealId,
      conversationId: sendConversationId,
      text,
      reason: row.reason ?? meta.label,
      payload,
    })
    if (!r.ok) error = r.error ?? 'Não deu certo.'
    else result = r.result ?? {}
  }

  const now = new Date().toISOString()
  if (error) {
    await db
      .update(agentActionRequests)
      .set({ error: error.slice(0, 500), attempts: (row.attempts ?? 0) + 1 })
      .where(eq(agentActionRequests.id, row.id))
    revalidatePath('/aprovacoes')
    return { ok: false, error }
  }
  await db
    .update(agentActionRequests)
    .set({
      status: meta.kind === 'message' ? 'sent' : 'done',
      suggestedText: text ?? row.suggestedText,
      payload,
      executedAt: now,
      resolvedAt: now,
      resolvedBy: ctx.userId,
      result,
      error: null,
    })
    .where(eq(agentActionRequests.id, row.id))
  if (row.signalId) {
    await db.update(customerSignals).set({ resolvedAt: now, updatedAt: now }).where(and(eq(customerSignals.id, row.signalId), isNull(customerSignals.resolvedAt)))
  }
  if (row.dealId) {
    await noteDealEvent(ctx.accountId, row.dealId, ctx.userId, `✅ ${meta.label} aprovado e executado. Por quê: ${row.reason ?? '—'}`)
  }
  revalidatePath('/aprovacoes')
  return { ok: true }
}

export async function rejectQueueItem(id: string, note?: string): Promise<ActionResult> {
  const ctx = await getCurrentAccount()
  if (ctx.role === 'viewer') return { ok: false, error: 'Seu papel só permite visualizar.' }
  const row = await loadPending(ctx.accountId, id)
  if (!row) return { ok: false, error: 'Este pedido não está mais pendente.' }
  const now = new Date().toISOString()
  await db
    .update(agentActionRequests)
    .set({ status: 'rejected', resolvedAt: now, resolvedBy: ctx.userId, result: note ? { note: note.slice(0, 500) } : null })
    .where(eq(agentActionRequests.id, id))
  if (row.dealId) {
    await noteDealEvent(ctx.accountId, row.dealId, ctx.userId, `🚫 Sugestão da Fluxia recusada (${ACTION_CATALOG[row.actionType as OrchAction]?.label ?? row.actionType}).${note ? ` Motivo: ${note}` : ''}`)
  }
  revalidatePath('/aprovacoes')
  return { ok: true }
}

/** Histórico recente (executadas/bloqueadas/recusadas) pra auditoria na mesma tela. */
export interface AuditItem {
  id: string
  action: OrchAction
  actionLabel: string
  status: string
  decision: string | null
  policy: string | null
  reason: string | null
  contactName: string | null
  dealId: string | null
  byHuman: boolean
  error: string | null
  at: string
}
export async function listRecentAudit(limit = 40): Promise<AuditItem[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: agentActionRequests.id,
      actionType: agentActionRequests.actionType,
      status: agentActionRequests.status,
      decision: agentActionRequests.decision,
      policy: agentActionRequests.policy,
      reason: agentActionRequests.reason,
      dealId: agentActionRequests.dealId,
      resolvedBy: agentActionRequests.resolvedBy,
      resolvedAt: agentActionRequests.resolvedAt,
      createdAt: agentActionRequests.createdAt,
      error: agentActionRequests.error,
      contactName: contacts.name,
    })
    .from(agentActionRequests)
    .leftJoin(contacts, eq(contacts.id, agentActionRequests.contactId))
    .where(and(eq(agentActionRequests.accountId, ctx.accountId), isNotNull(agentActionRequests.resolvedAt), gte(agentActionRequests.createdAt, new Date(Date.now() - 14 * 86_400_000).toISOString())))
    .orderBy(desc(agentActionRequests.resolvedAt))
    .limit(Math.max(1, Math.min(200, limit)))
  return rows
    .filter((r) => isOrchAction(r.actionType))
    .map((r) => ({
      id: r.id,
      action: r.actionType as OrchAction,
      actionLabel: ACTION_CATALOG[r.actionType as OrchAction].label,
      status: r.status,
      decision: r.decision,
      policy: r.policy,
      reason: r.reason,
      contactName: r.contactName ?? null,
      dealId: r.dealId,
      byHuman: !!r.resolvedBy,
      error: r.error,
      at: r.resolvedAt ?? r.createdAt,
    }))
}

// ---------------------------------------------------------------- canal / "o que acontece ao aprovar"

const PROVIDER_LABEL: Record<string, string> = {
  waha: 'WhatsApp',
  meta: 'WhatsApp oficial',
  whatsapp: 'WhatsApp',
  evolution: 'WhatsApp',
  evogo: 'WhatsApp',
  instagram: 'Instagram',
  messenger: 'Messenger',
  email: 'E-mail',
  gmail: 'E-mail',
}

function channelLabel(provider: string | null, name: string | null): string {
  const kind = provider ? (PROVIDER_LABEL[provider] ?? provider) : 'Canal'
  return name ? `${kind} · ${name}` : kind
}

function fmtWhen(v: unknown): string {
  const d = typeof v === 'string' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) return 'amanhã'
  try {
    return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return String(v)
  }
}

function describeEffect(args: {
  action: OrchAction
  payload: Record<string, unknown>
  dealTitle: string | null
  contactEmail: string | null
  proposal: { id: string; acceptedAt: string | null } | null
  items: number
}): { effect: string; warnings: string[]; proposalUrl: string | null } {
  const p = args.payload
  const deal = args.dealTitle ? `"${args.dealTitle}"` : 'o negócio'
  const warnings: string[] = []
  switch (args.action) {
    case 'send_followup':
    case 'reactivation':
      return { effect: 'Envia a mensagem abaixo pela conversa do contato no canal indicado — edite o texto e, se ele tiver mais de um canal, escolha por onde sai.', warnings, proposalUrl: null }
    case 'send_proposal': {
      if (!args.proposal) warnings.push('Não há proposta salva neste negócio. Abra o negócio → aba Propostas, salve a proposta e depois aprove aqui.')
      if (args.items === 0) warnings.push('A aba Produtos do negócio está vazia — o e-mail sairia sem itens (o envio falha).')
      if (!args.contactEmail) warnings.push('O contato não tem e-mail cadastrado — o envio falha. Cadastre o e-mail no contato ou recuse e mande a proposta pelo WhatsApp.')
      return {
        effect: `Envia por e-mail${args.contactEmail ? ` para ${args.contactEmail}` : ''} a proposta salva de ${deal}: itens da aba Produtos, totais e o link público da proposta (com aceite). A Fluxia NÃO escreve a proposta — ela manda a que estiver salva no negócio.`,
        warnings,
        proposalUrl: args.proposal ? `/proposta/${args.proposal.id}` : null,
      }
    }
    case 'apply_discount':
      return { effect: `Aplica ${Number(p.discountPct) || 0}% de desconto na proposta salva de ${deal} (só salva — não envia nada ao cliente).`, warnings, proposalUrl: args.proposal ? `/proposta/${args.proposal.id}` : null }
    case 'close_deal':
      return { effect: `Marca ${deal} como ${p.status === 'won' ? 'GANHO' : 'PERDIDO'}${typeof p.reason === 'string' && p.reason ? ` (motivo: ${p.reason})` : ''} e dispara as automações de ganho/perda da conta.`, warnings, proposalUrl: null }
    case 'move_deal': {
      const stage = typeof p.stageName === 'string' && p.stageName ? `"${p.stageName}"` : p.direction === 'next' ? 'seguinte' : 'indicada'
      return { effect: `Move ${deal} para a etapa ${stage} e cria as tarefas automáticas dessa etapa.`, warnings, proposalUrl: null }
    }
    case 'create_task':
      return { effect: `Cria a tarefa "${typeof p.title === 'string' && p.title ? p.title : 'Falar com o cliente'}" para o responsável de ${deal}, com prazo ${fmtWhen(p.dueAt)}.`, warnings, proposalUrl: null }
    case 'update_follow_up':
      return { effect: `Marca o próximo follow-up de ${deal} para ${fmtWhen(p.at)}.`, warnings, proposalUrl: null }
    case 'notify_seller':
      return { effect: 'Manda uma notificação no CRM para o responsável do negócio com o motivo acima. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'notify_owner':
      return { effect: 'Manda uma notificação no CRM para os administradores da conta. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'escalate':
      return { effect: 'Desliga a IA nesta conversa e avisa o time para assumir. Nada vai para o cliente.', warnings, proposalUrl: null }
    case 'start_cadence':
      return { effect: `Coloca o contato na cadência ${typeof p.cadenceName === 'string' && p.cadenceName ? `"${p.cadenceName}"` : 'escolhida'} (as mensagens da cadência passam a sair nos horários dela).`, warnings, proposalUrl: null }
    case 'pause_cadence':
      return { effect: 'Pausa a cadência ativa do contato (nenhuma mensagem sai).', warnings, proposalUrl: null }
    default:
      return { effect: 'Executa a ação indicada.', warnings, proposalUrl: null }
  }
}

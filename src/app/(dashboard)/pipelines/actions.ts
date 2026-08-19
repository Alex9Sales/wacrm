'use server'

// ============================================================
// Server actions for the Pipelines page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Every query is
// scoped to the caller's account — there is no RLS anymore.
// ============================================================

import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import { db, channels, companies, contacts, conversations, dealAttachments, dealContacts, dealEmails, dealEvents, dealProducts, dealQuestions, deals, member, notifications, pipelines, pipelineStages, user } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, type AccountContext } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getAdminUserIds } from '@/lib/sectors/access'
import type { Contact, Conversation, Deal, Pipeline, PipelineStage, Profile, CustomField } from '@/types'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { buildConversationContext } from '@/lib/ai/context'
import type { ChatMessage } from '@/lib/ai/types'
import {
  listContactCustomValues,
  saveContactCustomValues,
} from '@/app/(dashboard)/contacts/actions'
import { createTask } from '@/app/(dashboard)/tarefas/actions'
import { scheduleMessage } from '@/app/(dashboard)/inbox/schedule-actions'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { runDealSuggestions } from '@/lib/ai/deal-suggest'
import { planStageFollowUp } from '@/lib/ai/followup'
import { dealSuggestions } from '@/db'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

const contactColumns = {
  id: contacts.id,
  user_id: contacts.userId,
  account_id: contacts.accountId,
  phone: contacts.phone,
  phone_normalized: contacts.phoneNormalized,
  name: contacts.name,
  email: contacts.email,
  company: contacts.company,
  avatar_url: contacts.avatarUrl,
  created_at: contacts.createdAt,
  updated_at: contacts.updatedAt,
}

// Assignee identity is `user.id` (deals.assigned_to FK → user.id).
// Mapped into the legacy Profile shape the UI consumes; `id` and
// `user_id` both carry the user id so `<option value={p.id}>` writes a
// valid `deals.assigned_to` and lookups by user id still resolve.
const assigneeColumns = {
  id: user.id,
  user_id: user.id,
  full_name: user.name,
  email: user.email,
  avatar_url: user.image,
  created_at: user.createdAt,
}

/**
 * Funil ABERTO (05/08, spec Alex/Rafael): quem pode VER/ABRIR/EDITAR o card
 * completo de um deal.
 *   - admin / supervisor → tudo (supervisão).
 *   - agente → deal SEM dono (todos veem, pra poder pegar) OU atribuído a ele.
 *     Atribuído a OUTRO = travado ("atribuído a outra pessoa"), igual conversa.
 * (Antes: agente só via os DELE — a vendedora do Rafael perdeu acesso aos leads
 * sem dono; este modelo abre o funil e trava só o que é de outro.)
 */
function dealReadable(
  role: AccountContext['role'],
  userId: string,
  assignedTo: string | null | undefined,
): boolean {
  if (hasMinRole(role, 'supervisor')) return true
  if (!assignedTo) return true
  return assignedTo === userId
}

/** WHERE dos deals de um funil. Funil aberto: a query traz TODOS os deals; o
 *  bloqueio de "atribuído a outro" é por-card (dealReadable) na listagem — o
 *  card aparece TRAVADO, não some (igual a lista de conversas). */
async function dealsVisibilityWhere(ctx: AccountContext, pipelineId: string) {
  return and(
    eq(deals.pipelineId, pipelineId),
    eq(deals.accountId, ctx.accountId),
  ) as ReturnType<typeof and>
}

export async function listPipelines(): Promise<Pipeline[]> {
  const ctx = await getCurrentAccount()
  // Funil ABERTO: todos os membros veem todos os funis da conta.
  const where = eq(pipelines.accountId, ctx.accountId)
  const rows = await db
    .select({
      id: pipelines.id,
      user_id: pipelines.userId,
      account_id: pipelines.accountId,
      name: pipelines.name,
      stepper_style: pipelines.stepperStyle,
      created_at: pipelines.createdAt,
    })
    .from(pipelines)
    .where(where)
    .orderBy(asc(pipelines.createdAt))
  return rows as unknown as Pipeline[]
}

/** Stages of one pipeline (account-scoped through the parent), by position. */
export async function listStages(pipelineId: string): Promise<PipelineStage[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: pipelineStages.id,
      pipeline_id: pipelineStages.pipelineId,
      name: pipelineStages.name,
      position: pipelineStages.position,
      color: pipelineStages.color,
      objective: pipelineStages.objective,
      guidance: pipelineStages.guidance,
      created_at: pipelineStages.createdAt,
    })
    .from(pipelineStages)
    .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelines.accountId, ctx.accountId)))
    .orderBy(asc(pipelineStages.position))
  return rows as unknown as PipelineStage[]
}

/** IDs dos negócios (dentre os passados) que TÊM ao menos 1 produto — alimenta
 *  a métrica "Sem produtos" das estatísticas por etapa (uma query pro board). */
export async function getDealsWithProducts(
  dealIds: string[],
): Promise<string[]> {
  const ctx = await getCurrentAccount()
  const ids = Array.from(new Set(dealIds.filter((d): d is string => !!d)))
  if (ids.length === 0) return []
  const rows = await db
    .selectDistinct({ deal_id: dealProducts.dealId })
    .from(dealProducts)
    .where(
      and(
        eq(dealProducts.accountId, ctx.accountId),
        inArray(dealProducts.dealId, ids),
      ),
    )
  return rows.map((r) => r.deal_id).filter((d): d is string => !!d)
}

/**
 * Deals of one pipeline with `contact` and `assignee` embedded, newest
 * first. Mirrors the old
 * `select('*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)')`.
 */
export async function listDeals(pipelineId: string): Promise<Deal[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: deals.id,
      user_id: deals.userId,
      account_id: deals.accountId,
      pipeline_id: deals.pipelineId,
      stage_id: deals.stageId,
      contact_id: deals.contactId,
      conversation_id: deals.conversationId,
      assigned_to: deals.assignedTo,
      title: deals.title,
      value: deals.value,
      currency: deals.currency,
      notes: deals.notes,
      expected_close_date: deals.expectedCloseDate,
      status: deals.status,
      temperature: deals.temperature,
      qualification: deals.qualification,
      stage_changed_at: deals.stageChangedAt,
      next_follow_up_at: deals.nextFollowUpAt,
      follow_up_count: conversations.followUpStep,
      paused_at: deals.pausedAt,
      created_at: deals.createdAt,
      updated_at: deals.updatedAt,
      contact: contactColumns,
      assignee: assigneeColumns,
      company_id: deals.companyId,
      company_name: companies.name,
      // Canal de onde veio o lead (via conversa vinculada) — o card mostra o
      // ícone (WhatsApp/Instagram…) e clicar abre a conversa.
      channel_provider: channels.provider,
    })
    .from(deals)
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(user, eq(deals.assignedTo, user.id))
    .leftJoin(companies, eq(deals.companyId, companies.id))
    .leftJoin(conversations, eq(deals.conversationId, conversations.id))
    .leftJoin(channels, eq(conversations.channelId, channels.id))
    .where(await dealsVisibilityWhere(ctx, pipelineId))
    .orderBy(desc(deals.createdAt))

  return rows.map((r) => {
    const assignee = r.assignee?.id ? (r.assignee as unknown as Profile) : undefined
    // Atribuído a OUTRA pessoa (e não sou supervisor+) → card TRAVADO: não vaza
    // título/contato/valor; o board mostra só "atribuído a X" + a etapa.
    if (!dealReadable(ctx.role, ctx.userId, r.assigned_to)) {
      return { ...r, title: '', value: 0, notes: undefined, contact: undefined, company_id: null, company_name: null, assignee, read_blocked: true }
    }
    return {
      ...r,
      // numeric comes back as a string from node-postgres; the UI (and the
      // old PostgREST payload) expects a number.
      value: Number(r.value),
      contact: r.contact?.id ? (r.contact as unknown as Contact) : undefined,
      assignee,
      channel_provider: r.channel_provider ?? null,
      read_blocked: false,
    }
  }) as unknown as Deal[]
}

/**
 * Create a pipeline plus its default stages. Used both by the
 * first-visit auto-seed and the "Add Pipeline" dialog.
 */
export async function createPipelineWithStages(
  name: string,
  stages: { name: string; color: string; position: number }[],
): Promise<{ pipeline: Pipeline | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const pipeline = firstOrThrow(
      await db
        .insert(pipelines)
        .values({ userId: ctx.userId, accountId: ctx.accountId, name })
        .returning({
          id: pipelines.id,
          user_id: pipelines.userId,
          account_id: pipelines.accountId,
          name: pipelines.name,
          created_at: pipelines.createdAt,
        }),
    )
    if (stages.length > 0) {
      await db.insert(pipelineStages).values(
        stages.map((s) => ({
          pipelineId: pipeline.id,
          name: s.name,
          color: s.color,
          position: s.position,
        })),
      )
    }
    return { pipeline: pipeline as unknown as Pipeline, error: null }
  } catch (err) {
    return {
      pipeline: null,
      error: err instanceof Error ? err.message : 'Failed to create pipeline',
    }
  }
}

/** Persist a drag-and-drop stage move. Returns an error message or null. */
/** Append one timeline event for a deal (best-effort — never throws). */
async function recordDealEvent(
  accountId: string,
  actorUserId: string | null,
  dealId: string,
  type: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(dealEvents).values({ accountId, actorUserId, dealId, type, data })
  } catch (err) {
    console.error('[deal-events] insert failed:', err)
  }
}

/** Stage name for a stage id (for the timeline payload). */
async function stageName(stageId: string | null): Promise<string | null> {
  if (!stageId) return null
  const row = firstOrNull(
    await db
      .select({ name: pipelineStages.name })
      .from(pipelineStages)
      .where(eq(pipelineStages.id, stageId))
      .limit(1),
  )
  return row?.name ?? null
}

/**
 * Editar MANUALMENTE o "próximo follow-up" do card (estilo n8n: a data é
 * editável na mão). isoOrNull = ISO datetime, ou null pra limpar. Reabre o
 * disparo (stage_follow_up_at=null) pra o worker mandar no novo horário.
 */
export async function setDealNextFollowUp(
  dealId: string,
  isoOrNull: string | null,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const before = firstOrNull(
      await db
        .select({ assignedTo: deals.assignedTo })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!before) return { error: 'Deal not found' }
    if (!dealReadable(ctx.role, ctx.userId, before.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    const value =
      isoOrNull && !Number.isNaN(new Date(isoOrNull).getTime())
        ? new Date(isoOrNull).toISOString()
        : null
    await db
      .update(deals)
      .set({ nextFollowUpAt: value, stageFollowUpAt: null })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falhou' }
  }
}

/**
 * Abre a conversa do negócio: se já tem conversa vinculada, devolve ela; senão,
 * resolve/cria a conversa pelo telefone do contato e VINCULA ao negócio (pra da
 * próxima vez ser 1 clique). Usado pelo botão de WhatsApp no card e no detalhe.
 */
export async function openDealConversation(
  dealId: string,
): Promise<{ conversationId: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const deal = firstOrNull(
      await db
        .select({
          conversationId: deals.conversationId,
          contactId: deals.contactId,
          assignedTo: deals.assignedTo,
        })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!deal) return { conversationId: null, error: 'Negócio não encontrado' }
    if (!dealReadable(ctx.role, ctx.userId, deal.assignedTo)) {
      return { conversationId: null, error: 'Sem acesso a este negócio' }
    }
    if (deal.conversationId) {
      return { conversationId: deal.conversationId, error: null }
    }
    if (!deal.contactId) {
      return { conversationId: null, error: 'Negócio sem contato' }
    }
    const contact = firstOrNull(
      await db
        .select({ phone: contacts.phone, name: contacts.name })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, deal.contactId),
            eq(contacts.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!contact?.phone) {
      return { conversationId: null, error: 'Contato sem telefone (WhatsApp)' }
    }
    let resolved
    try {
      resolved = await resolveConversationByPhone(
        ctx.accountId,
        contact.phone,
        contact.name,
      )
    } catch {
      return { conversationId: null, error: 'Não foi possível abrir a conversa' }
    }
    // Vincula pra próxima vez ser direto.
    await db
      .update(deals)
      .set({ conversationId: resolved.conversationId })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
    return { conversationId: resolved.conversationId, error: null }
  } catch (err) {
    return {
      conversationId: null,
      error: err instanceof Error ? err.message : 'Erro',
    }
  }
}

export async function moveDealToStage(
  dealId: string,
  stageId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Grab the current stage first so the timeline can show from → to.
    const before = firstOrNull(
      await db
        .select({ stageId: deals.stageId, assignedTo: deals.assignedTo })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!before) return { error: 'Deal not found' }
    // Funil aberto: agente não move deal atribuído a outro.
    if (!dealReadable(ctx.role, ctx.userId, before.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    if (before.stageId === stageId) return { error: null }
    await db
      .update(deals)
      // stage_changed_at reinicia o contador de "dias na etapa" (estilo RD).
      .set({ stageId, stageChangedAt: sql`now()` })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
    const toStageName = await stageName(stageId)
    await recordDealEvent(ctx.accountId, ctx.userId, dealId, 'stage_changed', {
      from: await stageName(before.stageId),
      to: toStageName,
    })
    // Atualiza o "próximo follow-up" do card conforme a nova etapa — IMEDIATO,
    // não espera o tick de 5min (o Alex quer: mover o card recalcula a data).
    try {
      const d = firstOrNull(
        await db
          .select({ conversationId: deals.conversationId })
          .from(deals)
          .where(eq(deals.id, dealId))
          .limit(1),
      )
      if (d?.conversationId && toStageName) {
        await planStageFollowUp({
          accountId: ctx.accountId,
          dealId,
          conversationId: d.conversationId,
          stageName: toStageName,
        })
      }
    } catch (err) {
      console.error('[moveDealToStage] planStageFollowUp:', err)
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to move deal' }
  }
}

/**
 * Transferir lead (spec Alex 05/08): reatribui o deal a outro membro MANTENDO a
 * etapa (só troca o responsável). Grava evento no histórico + notifica.
 * Regra de notificação: admin→agente avisa SÓ o receptor; não-admin
 * (agente/supervisor)→outro avisa o receptor + os admins. Nunca avisa quem fez.
 */
export async function transferDeal(
  dealId: string,
  toUserId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!toUserId) return { error: 'Escolha para quem transferir.' }

    const row = firstOrNull(
      await db
        .select({ assignedTo: deals.assignedTo, contactId: deals.contactId })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!row) return { error: 'Negócio não encontrado.' }
    // Só quem já pode agir no deal transfere (dono, admin ou supervisor).
    if (!dealReadable(ctx.role, ctx.userId, row.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    if (row.assignedTo === toUserId) return { error: null } // já é do destino

    const nameOf = async (uid: string | null): Promise<string | null> => {
      if (!uid) return null
      const u = firstOrNull(
        await db.select({ name: user.name }).from(user).where(eq(user.id, uid)).limit(1),
      )
      return u?.name?.trim() || null
    }
    const [toName, byName] = await Promise.all([nameOf(toUserId), nameOf(ctx.userId)])

    // A ETAPA NÃO MUDA — só o responsável.
    await db
      .update(deals)
      .set({ assignedTo: toUserId })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))

    await recordDealEvent(ctx.accountId, ctx.userId, dealId, 'transferred', {
      to: toName,
      by: byName,
      by_role: ctx.role,
    })

    // Nome do lead p/ a mensagem da notificação.
    let contactName = 'um lead'
    if (row.contactId) {
      const c = firstOrNull(
        await db
          .select({ name: contacts.name, phone: contacts.phone })
          .from(contacts)
          .where(eq(contacts.id, row.contactId))
          .limit(1),
      )
      contactName = c?.name?.trim() || c?.phone || 'um lead'
    }

    // Destinatários: sempre o receptor; se quem fez NÃO é admin/owner, os admins.
    const recipients = new Set<string>([toUserId])
    if (!hasMinRole(ctx.role, 'admin')) {
      for (const a of await getAdminUserIds(ctx.accountId)) recipients.add(a)
    }
    recipients.delete(ctx.userId) // nunca notifica quem transferiu

    const notifRows = [...recipients].map((uid) => ({
      accountId: ctx.accountId,
      userId: uid,
      type: 'deal_transferred' as const,
      dealId,
      contactId: row.contactId,
      actorUserId: ctx.userId,
      title: uid === toUserId ? 'Lead transferido para você' : 'Lead transferido',
      body:
        uid === toUserId
          ? `${byName ?? 'Alguém'} transferiu o lead "${contactName}" para você.`
          : `${byName ?? 'Um atendente'} transferiu o lead "${contactName}" para ${toName ?? 'outro atendente'}.`,
    }))
    if (notifRows.length) {
      try {
        await db.insert(notifications).values(notifRows)
      } catch (err) {
        console.error('[transferDeal] notify failed:', err)
      }
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao transferir.' }
  }
}

// ============================================================
// Pipeline settings (pipeline-settings.tsx)
// ============================================================

/**
 * Rename a pipeline and upsert its stages in one round-trip. Mirrors the old
 * client-side `pipelines.update(name)` + `pipeline_stages.upsert(..., {onConflict:'id'})`.
 * Account-scoped: the rename filters on accountId and stages are only upserted
 * after confirming the pipeline belongs to the caller.
 */
export async function savePipelineSettings(
  pipelineId: string,
  name: string,
  stages: {
    id: string
    name: string
    color: string
    position: number
    objective?: string | null
    guidance?: string | null
  }[],
  stepperStyle?: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()

    // Confirm ownership before touching stages (stages have no accountId of
    // their own — ownership flows through the parent pipeline).
    const owned = firstOrNull(
      await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { error: 'Pipeline not found' }

    await db
      .update(pipelines)
      .set({
        name: name.trim(),
        ...(stepperStyle === 'pills' || stepperStyle === 'chevrons'
          ? { stepperStyle }
          : {}),
      })
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId)))

    if (stages.length > 0) {
      await db
        .insert(pipelineStages)
        .values(
          stages.map((s) => ({
            id: s.id,
            pipelineId,
            name: s.name,
            color: s.color,
            position: s.position,
            objective: s.objective ?? null,
            guidance: s.guidance ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: pipelineStages.id,
          set: {
            name: sql`excluded.name`,
            color: sql`excluded.color`,
            position: sql`excluded.position`,
            objective: sql`excluded.objective`,
            guidance: sql`excluded.guidance`,
          },
        })
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save pipeline' }
  }
}

/**
 * Add a single stage to a pipeline the caller owns. Returns the created stage
 * in snake_case shape (matches PipelineStage). Mirrors the old
 * `pipeline_stages.insert(...).select().single()`.
 */
export async function addStage(
  pipelineId: string,
  input: { name: string; color: string; position: number },
): Promise<{ stage: PipelineStage | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const owned = firstOrNull(
      await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { stage: null, error: 'Pipeline not found' }

    const stage = firstOrThrow(
      await db
        .insert(pipelineStages)
        .values({
          pipelineId,
          name: input.name,
          color: input.color,
          position: input.position,
        })
        .returning({
          id: pipelineStages.id,
          pipeline_id: pipelineStages.pipelineId,
          name: pipelineStages.name,
          position: pipelineStages.position,
          color: pipelineStages.color,
          created_at: pipelineStages.createdAt,
        }),
    )
    return { stage: stage as unknown as PipelineStage, error: null }
  } catch (err) {
    return { stage: null, error: err instanceof Error ? err.message : 'Failed to add stage' }
  }
}

/** Number of deals in a stage (account-scoped). Guards stage deletion. */
export async function countDealsInStage(stageId: string): Promise<number> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({ value: count() })
      .from(deals)
      .where(and(eq(deals.stageId, stageId), eq(deals.accountId, ctx.accountId))),
  )
  return row?.value ?? 0
}

/**
 * Delete a stage the caller owns (ownership via parent pipeline). The caller
 * should confirm no deals reference it first (see countDealsInStage).
 */
export async function deleteStage(stageId: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Only delete stages whose parent pipeline belongs to the caller.
    const owned = firstOrNull(
      await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
        .where(and(eq(pipelineStages.id, stageId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { error: 'Stage not found' }

    await db.delete(pipelineStages).where(eq(pipelineStages.id, stageId))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete stage' }
  }
}

/** Delete a pipeline the caller owns. ON DELETE CASCADE removes deals + stages. */
export async function deletePipeline(pipelineId: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete pipeline' }
  }
}

// ============================================================
// Deal form (deal-form.tsx)
// ============================================================

/** All contacts in the account, ordered by name (matches the old `.order('name')`). */
export async function listContactsForDeal(): Promise<Contact[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(contactColumns)
    .from(contacts)
    .where(eq(contacts.accountId, ctx.accountId))
    .orderBy(asc(contacts.name))
  return rows as unknown as Contact[]
}

/**
 * All members (potential assignees) in the account, ordered by name.
 * Mapped into the legacy Profile shape. The assignee id is `user.id`
 * because `deals.assigned_to` FK → user.id, so `<option value={p.id}>`
 * writes a valid assignment.
 */
export async function listAssignees(): Promise<Profile[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      ...assigneeColumns,
      account_id: member.organizationId,
      account_role: member.role,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.accountId))
    .orderBy(asc(user.name))
  return rows as unknown as Profile[]
}

/**
 * Newest conversation for a contact (account-scoped), or null. Mirrors the old
 * `conversations.select().eq('contact_id').order('last_message_at desc').limit(1).maybeSingle()`.
 */
export async function listConversationsForContact(
  contactId: string,
): Promise<Conversation | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        id: conversations.id,
        user_id: conversations.userId,
        account_id: conversations.accountId,
        contact_id: conversations.contactId,
        status: conversations.status,
        assigned_agent_id: conversations.assignedAgentId,
        last_message_text: conversations.lastMessageText,
        last_message_at: conversations.lastMessageAt,
        unread_count: conversations.unreadCount,
        created_at: conversations.createdAt,
        updated_at: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(eq(conversations.contactId, contactId), eq(conversations.accountId, ctx.accountId)),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
  return row as unknown as Conversation | null
}

export interface DealInput {
  title: string
  value: number
  currency: string
  contact_id: string
  pipeline_id: string
  stage_id: string
  assigned_to: string | null
  notes: string | null
  expected_close_date: string | null
  temperature?: string | null
  source?: string | null
  origin?: string | null
  /** Nota de qualificação 1..5 (estrela do card, estilo RD). */
  qualification?: number | null
  /** Conversa vinculada — quando o negócio nasce PELA conversa, guardamos o id
   *  aqui pra o card do funil mostrar a bolinha de chat (abre a conversa). */
  conversation_id?: string | null
}

/**
 * Create a deal. userId/accountId are derived from the caller — the old client
 * getSession() lookup is gone. Status defaults to 'open'.
 */
export async function createDeal(
  input: DealInput,
): Promise<{ error: string | null; id?: string }> {
  try {
    const ctx = await getCurrentAccount()
    // Empresas Fase 2: o negócio herda a empresa do contato (se ele tiver uma).
    const contactCompany = input.contact_id
      ? firstOrNull(
          await db
            .select({ companyId: contacts.companyId })
            .from(contacts)
            .where(
              and(
                eq(contacts.id, input.contact_id),
                eq(contacts.accountId, ctx.accountId),
              ),
            )
            .limit(1),
        )
      : null
    const created = firstOrNull(
      await db
        .insert(deals)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          title: input.title,
          value: String(input.value),
          currency: input.currency,
          contactId: input.contact_id,
          companyId: contactCompany?.companyId ?? null,
          conversationId: input.conversation_id ?? null,
          pipelineId: input.pipeline_id,
          stageId: input.stage_id,
          assignedTo: input.assigned_to,
          notes: input.notes,
          expectedCloseDate: input.expected_close_date,
          temperature: input.temperature ?? null,
          source: input.source ?? null,
          origin: input.origin ?? null,
          qualification: input.qualification ?? null,
          status: 'open',
        })
        .returning({ id: deals.id }),
    )
    if (created?.id) {
      await recordDealEvent(ctx.accountId, ctx.userId, created.id, 'created', {
        stage: await stageName(input.stage_id),
      })
    }
    return { error: null, id: created?.id }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create deal' }
  }
}

/** Duplica um negócio (estilo RD): copia os campos + os produtos numa nova
 *  negociação "(cópia)" na MESMA etapa. Não copia tarefas/histórico. */
export async function duplicateDeal(
  id: string,
): Promise<{ error: string | null; id?: string }> {
  try {
    const ctx = await getCurrentAccount()
    const src = firstOrNull(
      await db
        .select({
          title: deals.title,
          value: deals.value,
          currency: deals.currency,
          contactId: deals.contactId,
          pipelineId: deals.pipelineId,
          stageId: deals.stageId,
          assignedTo: deals.assignedTo,
          notes: deals.notes,
          expectedCloseDate: deals.expectedCloseDate,
          temperature: deals.temperature,
          source: deals.source,
          origin: deals.origin,
          qualification: deals.qualification,
        })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!src) return { error: 'Negócio não encontrado' }
    if (!dealReadable(ctx.role, ctx.userId, src.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    const created = firstOrNull(
      await db
        .insert(deals)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          title: `${src.title} (cópia)`,
          value: src.value,
          currency: src.currency,
          contactId: src.contactId,
          pipelineId: src.pipelineId,
          stageId: src.stageId,
          assignedTo: src.assignedTo,
          notes: src.notes,
          expectedCloseDate: src.expectedCloseDate,
          temperature: src.temperature,
          source: src.source,
          origin: src.origin,
          qualification: src.qualification,
          status: 'open',
        })
        .returning({ id: deals.id }),
    )
    if (!created?.id) return { error: 'Falha ao duplicar' }
    await recordDealEvent(ctx.accountId, ctx.userId, created.id, 'created', {
      stage: await stageName(src.stageId),
    })
    // Copia os produtos (itens) da negociação original.
    const prods = await db
      .select({
        name: dealProducts.name,
        quantity: dealProducts.quantity,
        unitPrice: dealProducts.unitPrice,
      })
      .from(dealProducts)
      .where(eq(dealProducts.dealId, id))
    if (prods.length > 0) {
      await db.insert(dealProducts).values(
        prods.map((p) => ({
          accountId: ctx.accountId,
          dealId: created.id,
          name: p.name,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
        })),
      )
    }
    return { error: null, id: created.id }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to duplicate deal' }
  }
}

/** Patch a deal the caller owns. Accepts a partial snake_case patch. Records a
 *  timeline event for stage/status changes. */
export async function updateDeal(
  id: string,
  patch: Partial<DealInput> & {
    status?: string
    lost_reason?: string | null
    qualification?: number | null
  },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Load current stage/status to detect meaningful changes for the timeline.
    const before = firstOrNull(
      await db
        .select({ stageId: deals.stageId, status: deals.status, assignedTo: deals.assignedTo })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!before) return { error: 'Deal not found' }
    // Funil aberto: agente só mexe em deal SEM dono ou atribuído a ele.
    if (!dealReadable(ctx.role, ctx.userId, before.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }

    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) set.title = patch.title
    if (patch.value !== undefined) set.value = String(patch.value)
    if (patch.currency !== undefined) set.currency = patch.currency
    if (patch.contact_id !== undefined) set.contactId = patch.contact_id
    if (patch.conversation_id !== undefined) set.conversationId = patch.conversation_id
    if (patch.pipeline_id !== undefined) set.pipelineId = patch.pipeline_id
    if (patch.stage_id !== undefined) set.stageId = patch.stage_id
    if (patch.assigned_to !== undefined) set.assignedTo = patch.assigned_to
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.expected_close_date !== undefined) set.expectedCloseDate = patch.expected_close_date
    if (patch.temperature !== undefined) set.temperature = patch.temperature
    if (patch.source !== undefined) set.source = patch.source
    if (patch.origin !== undefined) set.origin = patch.origin
    if (patch.qualification !== undefined) set.qualification = patch.qualification
    if (patch.status !== undefined) set.status = patch.status
    // Motivo de perda: guarda ao marcar 'lost'; limpa ao reabrir/ganhar.
    if (patch.status === 'lost' && patch.lost_reason !== undefined) {
      set.lostReason = patch.lost_reason
    } else if (patch.status === 'open' || patch.status === 'won') {
      set.lostReason = null
    } else if (patch.lost_reason !== undefined) {
      set.lostReason = patch.lost_reason
    }
    // Mudou de etapa → reinicia o "dias na etapa".
    const stageChanged =
      patch.stage_id !== undefined && patch.stage_id !== before.stageId
    if (stageChanged) set.stageChangedAt = sql`now()`

    await db
      .update(deals)
      .set(set)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))

    if (stageChanged) {
      await recordDealEvent(ctx.accountId, ctx.userId, id, 'stage_changed', {
        from: await stageName(before.stageId),
        to: await stageName(patch.stage_id!),
      })
    }
    if (patch.status !== undefined && patch.status !== before.status) {
      await recordDealEvent(ctx.accountId, ctx.userId, id, 'status_changed', {
        from: before.status,
        to: patch.status,
        // Motivo aparece na timeline: "marcou como perdida, motivo: X".
        ...(patch.status === 'lost' && patch.lost_reason
          ? { reason: patch.lost_reason }
          : {}),
      })
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update deal' }
  }
}

/** Mark a deal as won ('venda') / lost ('perda') / reopen ('open').
 *  Ao marcar PERDA, `reason` registra o motivo (estilo RD). */
export async function setDealStatus(
  id: string,
  status: 'open' | 'won' | 'lost',
  reason?: string | null,
): Promise<{ error: string | null }> {
  return updateDeal(id, {
    status,
    ...(status === 'lost' ? { lost_reason: (reason ?? '').trim() || null } : {}),
  })
}

/** Pausar / retomar um negócio (estilo RD). Fica na etapa; só marca paused_at. */
export async function setDealPaused(
  id: string,
  paused: boolean,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const owned = firstOrNull(
      await db
        .select({ assignedTo: deals.assignedTo })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Negócio não encontrado' }
    if (!dealReadable(ctx.role, ctx.userId, owned.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    await db
      .update(deals)
      .set({ pausedAt: paused ? sql`now()` : null })
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to pause deal' }
  }
}

/** Add a free-text note to a deal's timeline. */
export async function addDealNote(
  dealId: string,
  text: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const trimmed = text.trim()
    if (!trimmed) return { error: 'A anotação não pode ficar vazia.' }
    const owned = firstOrNull(
      await db
        .select({ id: deals.id, assignedTo: deals.assignedTo })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Negócio não encontrado.' }
    if (!dealReadable(ctx.role, ctx.userId, owned.assignedTo)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    await recordDealEvent(ctx.accountId, ctx.userId, dealId, 'note', { text: trimmed })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to add note' }
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One deal with contact/assignee/stage/pipeline embedded, for the detail page.
 *  Account-scoped; returns null when missing or in another account. */
export async function getDeal(id: string): Promise<Deal | null> {
  // A non-UUID id (e.g. a stray link landing on /pipelines/pipelines) must not
  // crash the detail page with a raw Postgres "invalid input syntax for uuid" —
  // treat it as not-found so the UI shows its empty state instead of a 500.
  if (!UUID_RE.test(id)) return null
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        id: deals.id,
        user_id: deals.userId,
        account_id: deals.accountId,
        pipeline_id: deals.pipelineId,
        stage_id: deals.stageId,
        contact_id: deals.contactId,
        company_id: deals.companyId,
        company_name: companies.name,
        conversation_id: deals.conversationId,
        // Canal de origem (via conversa vinculada) — o botão "Abrir conversa"
        // usa isso pra nomear o canal certo (WhatsApp/Instagram/Messenger).
        channel_provider: channels.provider,
        assigned_to: deals.assignedTo,
        title: deals.title,
        value: deals.value,
        currency: deals.currency,
        notes: deals.notes,
        expected_close_date: deals.expectedCloseDate,
        temperature: deals.temperature,
        source: deals.source,
        origin: deals.origin,
        status: deals.status,
        created_at: deals.createdAt,
        updated_at: deals.updatedAt,
        contact: contactColumns,
        assignee: assigneeColumns,
        pipeline_name: pipelines.name,
        pipeline_stepper_style: pipelines.stepperStyle,
      })
      .from(deals)
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .leftJoin(companies, eq(deals.companyId, companies.id))
      .leftJoin(user, eq(deals.assignedTo, user.id))
      .leftJoin(pipelines, eq(deals.pipelineId, pipelines.id))
      .leftJoin(conversations, eq(deals.conversationId, conversations.id))
      .leftJoin(channels, eq(conversations.channelId, channels.id))
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!row) return null
  // Funil aberto: agente abre deal SEM dono ou atribuído a ele; atribuído a
  // outro = bloqueado. admin/supervisor veem tudo.
  if (!dealReadable(ctx.role, ctx.userId, row.assigned_to)) return null
  return {
    ...row,
    value: Number(row.value),
    contact: row.contact?.id ? (row.contact as unknown as Contact) : undefined,
    assignee: row.assignee?.id ? (row.assignee as unknown as Profile) : undefined,
  } as unknown as Deal
}

// ============================================================
// Empresas Fase 2 — empresa + contatos do negócio.
// ============================================================

/** Define (ou limpa, com null) a empresa vinculada ao negócio. */
export async function setDealCompany(
  dealId: string,
  companyId: string | null,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    let companyName: string | null = null
    if (companyId) {
      const co = firstOrNull(
        await db
          .select({ name: companies.name })
          .from(companies)
          .where(and(eq(companies.id, companyId), eq(companies.accountId, ctx.accountId)))
          .limit(1),
      )
      if (!co) return { error: 'Empresa não encontrada.' }
      companyName = co.name
    }
    const updated = await db
      .update(deals)
      .set({ companyId, updatedAt: new Date().toISOString() })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
      .returning({ id: deals.id })
    if (updated.length === 0) return { error: 'Negócio não encontrado.' }
    await recordDealEvent(ctx.accountId, ctx.userId, dealId, 'note', {
      text: companyName
        ? `Empresa vinculada: ${companyName}`
        : 'Empresa desvinculada do negócio',
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao vincular empresa.' }
  }
}

export interface DealContactRow {
  id: string
  name: string | null
  phone: string
  email: string | null
  avatar_url: string | null
  is_primary: boolean
}

/** Contatos do negócio: o PRINCIPAL (deals.contact_id) + os ADICIONAIS
 *  (deal_contacts). O principal vem marcado `is_primary`. */
export async function listDealContacts(dealId: string): Promise<DealContactRow[]> {
  const ctx = await getCurrentAccount()
  const deal = firstOrNull(
    await db
      .select({ contactId: deals.contactId })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!deal) return []
  const extras = await db
    .select({
      id: contacts.id,
      name: contacts.name,
      phone: contacts.phone,
      email: contacts.email,
      avatar_url: contacts.avatarUrl,
    })
    .from(dealContacts)
    .innerJoin(contacts, eq(dealContacts.contactId, contacts.id))
    .where(
      and(eq(dealContacts.dealId, dealId), eq(dealContacts.accountId, ctx.accountId)),
    )
    .orderBy(asc(contacts.name))

  const out: DealContactRow[] = []
  if (deal.contactId) {
    const primary = firstOrNull(
      await db
        .select({
          id: contacts.id,
          name: contacts.name,
          phone: contacts.phone,
          email: contacts.email,
          avatar_url: contacts.avatarUrl,
        })
        .from(contacts)
        .where(and(eq(contacts.id, deal.contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (primary) {
      out.push({
        id: primary.id,
        name: primary.name ?? null,
        phone: primary.phone,
        email: primary.email ?? null,
        avatar_url: primary.avatar_url ?? null,
        is_primary: true,
      })
    }
  }
  for (const c of extras) {
    if (c.id === deal.contactId) continue // já entrou como principal
    out.push({
      id: c.id,
      name: c.name ?? null,
      phone: c.phone,
      email: c.email ?? null,
      avatar_url: c.avatar_url ?? null,
      is_primary: false,
    })
  }
  return out
}

/** Adiciona um contato ADICIONAL ao negócio (idempotente). */
export async function addDealContact(
  dealId: string,
  contactId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const deal = firstOrNull(
      await db
        .select({ id: deals.id, contactId: deals.contactId })
        .from(deals)
        .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!deal) return { error: 'Negócio não encontrado.' }
    if (deal.contactId === contactId) {
      return { error: 'Esse contato já é o principal do negócio.' }
    }
    const contact = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!contact) return { error: 'Contato não encontrado.' }
    await db
      .insert(dealContacts)
      .values({ accountId: ctx.accountId, dealId, contactId })
      .onConflictDoNothing()
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao adicionar contato.' }
  }
}

/** Remove um contato ADICIONAL do negócio (não afeta o principal). */
export async function removeDealContact(
  dealId: string,
  contactId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(dealContacts)
      .where(
        and(
          eq(dealContacts.dealId, dealId),
          eq(dealContacts.contactId, contactId),
          eq(dealContacts.accountId, ctx.accountId),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover contato.' }
  }
}

export interface DealEvent {
  id: string
  type: string
  data: Record<string, unknown>
  actor_name: string | null
  created_at: string
}

/** A deal's timeline (newest first), with the actor's display name resolved. */
export async function listDealEvents(dealId: string): Promise<DealEvent[]> {
  const ctx = await getCurrentAccount()
  // Scope through the parent deal's account.
  const owned = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!owned) return []
  const rows = await db
    .select({
      id: dealEvents.id,
      type: dealEvents.type,
      data: dealEvents.data,
      created_at: dealEvents.createdAt,
      actor_name: user.name,
    })
    .from(dealEvents)
    .leftJoin(user, eq(dealEvents.actorUserId, user.id))
    .where(eq(dealEvents.dealId, dealId))
    .orderBy(desc(dealEvents.createdAt))
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    data: (r.data ?? {}) as Record<string, unknown>,
    actor_name: r.actor_name ?? null,
    created_at: r.created_at as unknown as string,
  }))
}

/** True when the deal belongs to the caller's account. */
async function assertDealInAccount(
  ctx: AccountContext,
  dealId: string,
): Promise<boolean> {
  const owned = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
      .limit(1),
  )
  return !!owned
}

// ============================================================
// Produtos (itens) do negócio
// ============================================================
export interface DealProduct {
  id: string
  name: string
  quantity: number
  unit_price: number
}

export async function listDealProducts(dealId: string): Promise<DealProduct[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertDealInAccount(ctx, dealId))) return []
  const rows = await db
    .select({
      id: dealProducts.id,
      name: dealProducts.name,
      quantity: dealProducts.quantity,
      unit_price: dealProducts.unitPrice,
    })
    .from(dealProducts)
    .where(eq(dealProducts.dealId, dealId))
    .orderBy(asc(dealProducts.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    quantity: Number(r.quantity),
    unit_price: Number(r.unit_price),
  }))
}

/** Recompute a deal's value from its products (nome × qtd × preço). Keeps the
 *  deal value in sync with the products total. Only overwrites when there IS at
 *  least one product — removing the last one preserves the manual value. */
async function syncDealValueToProducts(
  accountId: string,
  dealId: string,
): Promise<void> {
  const rows = await db
    .select({ quantity: dealProducts.quantity, unit_price: dealProducts.unitPrice })
    .from(dealProducts)
    .where(eq(dealProducts.dealId, dealId))
  if (rows.length === 0) return
  const total = rows.reduce(
    (sum, r) => sum + Number(r.quantity) * Number(r.unit_price),
    0,
  )
  await db
    .update(deals)
    .set({ value: String(total) })
    .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
}

export async function addDealProduct(
  dealId: string,
  input: { name: string; quantity: number; unit_price: number },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!(await assertDealInAccount(ctx, dealId)))
      return { error: 'Negócio não encontrado.' }
    const name = input.name.trim()
    if (!name) return { error: 'Informe o nome do produto.' }
    await db.insert(dealProducts).values({
      accountId: ctx.accountId,
      dealId,
      name,
      quantity: String(input.quantity > 0 ? input.quantity : 1),
      unitPrice: String(input.unit_price >= 0 ? input.unit_price : 0),
    })
    await syncDealValueToProducts(ctx.accountId, dealId)
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao adicionar produto' }
  }
}

export async function removeDealProduct(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Grab the deal id first so we can resync its value after removal.
    const prod = firstOrNull(
      await db
        .select({ dealId: dealProducts.dealId })
        .from(dealProducts)
        .where(and(eq(dealProducts.id, id), eq(dealProducts.accountId, ctx.accountId)))
        .limit(1),
    )
    await db
      .delete(dealProducts)
      .where(and(eq(dealProducts.id, id), eq(dealProducts.accountId, ctx.accountId)))
    if (prod) await syncDealValueToProducts(ctx.accountId, prod.dealId)
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover produto' }
  }
}

// ============================================================
// Arquivos/anexos do negócio (binário no MinIO via /api/media/upload)
// ============================================================
export interface DealAttachment {
  id: string
  name: string
  url: string
  mime: string | null
  size: number | null
  created_at: string
}

export async function listDealAttachments(
  dealId: string,
): Promise<DealAttachment[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertDealInAccount(ctx, dealId))) return []
  const rows = await db
    .select({
      id: dealAttachments.id,
      name: dealAttachments.name,
      url: dealAttachments.url,
      mime: dealAttachments.mime,
      size: dealAttachments.size,
      created_at: dealAttachments.createdAt,
    })
    .from(dealAttachments)
    .where(eq(dealAttachments.dealId, dealId))
    .orderBy(desc(dealAttachments.createdAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    mime: r.mime ?? null,
    size: r.size ?? null,
    created_at: r.created_at as unknown as string,
  }))
}

export async function addDealAttachment(
  dealId: string,
  input: { name: string; url: string; mime?: string | null; size?: number | null },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!(await assertDealInAccount(ctx, dealId)))
      return { error: 'Negócio não encontrado.' }
    if (!input.url) return { error: 'Arquivo inválido.' }
    await db.insert(dealAttachments).values({
      accountId: ctx.accountId,
      dealId,
      uploadedBy: ctx.userId,
      name: input.name || 'arquivo',
      url: input.url,
      mime: input.mime ?? null,
      size: input.size ?? null,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao anexar arquivo' }
  }
}

export async function removeDealAttachment(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(dealAttachments)
      .where(and(eq(dealAttachments.id, id), eq(dealAttachments.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover arquivo' }
  }
}

// ============================================================
// Questionários (perguntas de qualificação) do negócio
// ============================================================
export interface DealQuestion {
  id: string
  question: string
  answer: string | null
}

export async function listDealQuestions(dealId: string): Promise<DealQuestion[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertDealInAccount(ctx, dealId))) return []
  const rows = await db
    .select({ id: dealQuestions.id, question: dealQuestions.question, answer: dealQuestions.answer })
    .from(dealQuestions)
    .where(eq(dealQuestions.dealId, dealId))
    .orderBy(asc(dealQuestions.createdAt))
  return rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer ?? null }))
}

export async function addDealQuestion(
  dealId: string,
  input: { question: string; answer?: string | null },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!(await assertDealInAccount(ctx, dealId))) return { error: 'Negócio não encontrado.' }
    const question = input.question.trim()
    if (!question) return { error: 'Informe a pergunta.' }
    await db.insert(dealQuestions).values({
      accountId: ctx.accountId,
      dealId,
      question,
      answer: input.answer?.trim() || null,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao adicionar pergunta' }
  }
}

export async function updateDealQuestionAnswer(
  id: string,
  answer: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(dealQuestions)
      .set({ answer: answer.trim() || null })
      .where(and(eq(dealQuestions.id, id), eq(dealQuestions.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao salvar resposta' }
  }
}

export async function removeDealQuestion(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(dealQuestions)
      .where(and(eq(dealQuestions.id, id), eq(dealQuestions.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover pergunta' }
  }
}

// ============================================================
// E-mails registrados/anexados ao negócio (registro, não envio)
// ============================================================
export interface DealEmail {
  id: string
  subject: string
  body: string | null
  actor_name: string | null
  created_at: string
}

export async function listDealEmails(dealId: string): Promise<DealEmail[]> {
  const ctx = await getCurrentAccount()
  if (!(await assertDealInAccount(ctx, dealId))) return []
  const rows = await db
    .select({
      id: dealEmails.id,
      subject: dealEmails.subject,
      body: dealEmails.body,
      created_at: dealEmails.createdAt,
      actor_name: user.name,
    })
    .from(dealEmails)
    .leftJoin(user, eq(dealEmails.actorUserId, user.id))
    .where(eq(dealEmails.dealId, dealId))
    .orderBy(desc(dealEmails.createdAt))
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    body: r.body ?? null,
    actor_name: r.actor_name ?? null,
    created_at: r.created_at as unknown as string,
  }))
}

export async function addDealEmail(
  dealId: string,
  input: { subject: string; body?: string | null },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (!(await assertDealInAccount(ctx, dealId))) return { error: 'Negócio não encontrado.' }
    const subject = input.subject.trim()
    if (!subject) return { error: 'Informe o assunto.' }
    await db.insert(dealEmails).values({
      accountId: ctx.accountId,
      dealId,
      actorUserId: ctx.userId,
      subject,
      body: input.body?.trim() || null,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao registrar e-mail' }
  }
}

export async function removeDealEmail(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(dealEmails)
      .where(and(eq(dealEmails.id, id), eq(dealEmails.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao remover e-mail' }
  }
}

/** Delete a deal the caller owns. */
export async function deleteDeal(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.delete(deals).where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete deal' }
  }
}

// ------------------------------------------------------------
// IA para Negociações v2 — Fase 0: "Pergunte à IA" sobre o negócio.
// Read-only: monta o contexto (campos + histórico + conversa vinculada) e
// responde a pergunta do vendedor. NÃO grava nada (as fases 1+ trazem as
// sugestões por evidência). Reusa a plataforma de IA (loadAiConfig/generateReply).
// ------------------------------------------------------------
function describeDealEvent(e: DealEvent): string {
  const d = e.data as Record<string, unknown>
  switch (e.type) {
    case 'created':
      return `negócio criado${d.stage ? ` na etapa "${String(d.stage)}"` : ''}`
    case 'stage_changed':
      return `mudou de etapa "${String(d.from ?? '—')}" → "${String(d.to ?? '—')}"`
    case 'status_changed':
      if (d.to === 'won') return 'marcado como VENDA (ganho)'
      if (d.to === 'lost')
        return `marcado como PERDIDO${d.reason ? ` · motivo: ${String(d.reason)}` : ''}`
      return 'negócio reaberto'
    case 'note':
      return `anotação: ${String(d.text ?? '')}`
    case 'transferred':
      return `transferido${d.to ? ` para ${String(d.to)}` : ''}`
    default:
      return e.type
  }
}

function buildDealAskPrompt(
  deal: Deal,
  events: DealEvent[],
  convo: ChatMessage[],
): string {
  const fields = [
    `Título: ${deal.title}`,
    `Etapa: ${deal.stage?.name ?? '—'}`,
    `Status: ${deal.status ?? 'open'}${deal.paused_at ? ' (PAUSADO)' : ''}`,
    `Valor: ${deal.value} ${deal.currency ?? ''}`.trim(),
    deal.contact?.name
      ? `Contato: ${deal.contact.name}${deal.contact.phone ? ` (${deal.contact.phone})` : ''}`
      : null,
    deal.temperature ? `Temperatura: ${deal.temperature}` : null,
    deal.qualification ? `Qualificação: ${deal.qualification}/5` : null,
    deal.source ? `Fonte: ${deal.source}` : null,
    deal.expected_close_date
      ? `Fechamento previsto: ${deal.expected_close_date}`
      : null,
    deal.lost_reason ? `Motivo de perda: ${deal.lost_reason}` : null,
    deal.notes ? `Observações: ${deal.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  // events vêm do mais novo pro mais antigo; invertemos p/ ordem cronológica.
  const timeline = events
    .slice(0, 20)
    .reverse()
    .map((e) => `- ${describeDealEvent(e)}`)
    .join('\n')
  const transcript = convo
    .slice(-40)
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.content}`)
    .join('\n')
  return `Você é um assistente de vendas dentro de um CRM de WhatsApp. Responda à pergunta do vendedor SOBRE ESTE NEGÓCIO usando SOMENTE as informações abaixo (campos, histórico e a conversa com o cliente). Seja direto, prático e em português do Brasil. Se algo não estiver nos dados, diga que não há essa informação — NUNCA invente fatos sobre o cliente.

## Negócio
${fields}

## Histórico
${timeline || '(sem eventos)'}

## Conversa com o cliente (mais recente por último)
${transcript || '(nenhuma conversa vinculada)'}`
}

export async function askDealAI(
  dealId: string,
  question: string,
): Promise<{ answer?: string; error?: string }> {
  try {
    const ctx = await getCurrentAccount()
    const q = (question ?? '').trim()
    if (!q) return { error: 'Escreva uma pergunta.' }
    // requireActive:false — o "Pergunte à IA" funciona mesmo com o agente de
    // auto-resposta desligado; só precisa da chave de IA da conta.
    const cfg = await loadAiConfig(ctx.accountId, { requireActive: false }).catch(
      () => null,
    )
    if (!cfg) {
      return {
        error:
          'IA não configurada nesta conta. Configure em Configurações → Agente IA.',
      }
    }
    const deal = await getDeal(dealId)
    if (!deal) return { error: 'Negócio não encontrado.' }
    if (!dealReadable(ctx.role, ctx.userId, deal.assigned_to ?? null)) {
      return { error: 'Este negócio está atribuído a outro atendente.' }
    }
    const [events, convo] = await Promise.all([
      listDealEvents(dealId).catch(() => [] as DealEvent[]),
      deal.conversation_id
        ? buildConversationContext(deal.conversation_id).catch(
            () => [] as ChatMessage[],
          )
        : Promise.resolve([] as ChatMessage[]),
    ])
    const result = await generateReply({
      config: cfg,
      systemPrompt: buildDealAskPrompt(deal, events, convo),
      messages: [{ role: 'user', content: q }],
    })
    return { answer: result.text?.trim() || 'Não consegui gerar uma resposta.' }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Falha ao consultar a IA.',
    }
  }
}

// ------------------------------------------------------------
// IA para Negociações v2 — Fase 1: SUGESTÕES POR EVIDÊNCIA.
// A IA lê a conversa + campos e PROPÕE valores (campos do negócio + campos
// personalizados do contato) COM a evidência. Nada é gravado sozinho: vira
// sugestão 'pending' que o humano aceita (aplica) ou descarta.
// ------------------------------------------------------------
export interface DealSuggestion {
  id: string
  deal_id: string
  kind: string
  target: string
  label: string
  value: string
  evidence: string | null
  due_at: string | null
  status: string
  created_at: string
}

/** Sugestões PENDENTES de um negócio (mais novas primeiro). */
export async function listDealSuggestions(
  dealId: string,
): Promise<DealSuggestion[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: dealSuggestions.id,
      deal_id: dealSuggestions.dealId,
      kind: dealSuggestions.kind,
      target: dealSuggestions.target,
      label: dealSuggestions.label,
      value: dealSuggestions.value,
      evidence: dealSuggestions.evidence,
      due_at: dealSuggestions.dueAt,
      status: dealSuggestions.status,
      created_at: dealSuggestions.createdAt,
    })
    .from(dealSuggestions)
    .where(
      and(
        eq(dealSuggestions.dealId, dealId),
        eq(dealSuggestions.accountId, ctx.accountId),
        eq(dealSuggestions.status, 'pending'),
      ),
    )
    .orderBy(desc(dealSuggestions.createdAt))
  return rows as unknown as DealSuggestion[]
}

/** Roda a IA sobre a conversa e cria sugestões PENDENTES (substitui as antigas
 *  pendentes deste negócio). Fina camada de auth por cima do núcleo
 *  compartilhado `runDealSuggestions` (reusado pelo worker proativo — Fase 3). */
export async function generateDealSuggestions(
  dealId: string,
): Promise<{ count: number; error?: string }> {
  try {
    const ctx = await getCurrentAccount()
    // getDeal já aplica o gate de leitura (null se atribuído a outro atendente).
    const deal = await getDeal(dealId)
    if (!deal) return { count: 0, error: 'Negócio não encontrado.' }
    return await runDealSuggestions({
      accountId: ctx.accountId,
      dealId,
      createdBy: ctx.userId,
    })
  } catch (err) {
    return {
      count: 0,
      error: err instanceof Error ? err.message : 'Falha ao gerar sugestões.',
    }
  }
}

/** Agenda a mensagem sugerida (kind='message') na conversa do negócio: cria a
 *  mensagem agendada (dispara sozinha via worker), marca a sugestão 'accepted'
 *  e registra na timeline. Usada tanto pelo fluxo de confirmar/editar quanto
 *  como fallback do acceptDealSuggestion. */
async function scheduleSuggestedMessage(
  ctx: AccountContext,
  sug: { id: string; dealId: string },
  text: string,
  scheduledAt: string,
): Promise<{ error: string | null }> {
  const body = (text ?? '').trim()
  if (!body) return { error: 'Escreva a mensagem.' }
  const deal = await getDeal(sug.dealId)
  if (!deal) return { error: 'Negócio não encontrado.' }
  if (!deal.conversation_id) {
    return {
      error: 'Este negócio não tem conversa vinculada para enviar a mensagem.',
    }
  }
  const res = await scheduleMessage({
    conversationId: deal.conversation_id,
    contentText: body,
    scheduledAt,
  })
  if (!res.ok) return { error: res.error }

  await db
    .update(dealSuggestions)
    .set({ status: 'accepted' })
    .where(eq(dealSuggestions.id, sug.id))

  // Rótulo de data/hora amigável no fuso da conta + prévia do texto.
  let quando = ''
  try {
    const settings = await getAccountSettings(ctx.accountId)
    quando = new Intl.DateTimeFormat('pt-BR', {
      timeZone: settings.businessTimezone || 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(scheduledAt))
  } catch {
    /* fuso ruim → sem rótulo */
  }
  const preview = body.length > 160 ? `${body.slice(0, 160)}…` : body
  await recordDealEvent(ctx.accountId, ctx.userId, sug.dealId, 'note', {
    text: quando
      ? `IA agendou mensagem de follow-up para ${quando}: ${preview}`
      : `IA agendou mensagem de follow-up: ${preview}`,
  })
  return { error: null }
}

/** Aceita uma sugestão: APLICA o valor no campo certo + marca 'accepted' +
 *  registra na timeline. */
export async function acceptDealSuggestion(
  suggestionId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const sug = firstOrNull(
      await db
        .select({
          id: dealSuggestions.id,
          dealId: dealSuggestions.dealId,
          kind: dealSuggestions.kind,
          target: dealSuggestions.target,
          label: dealSuggestions.label,
          value: dealSuggestions.value,
          evidence: dealSuggestions.evidence,
          dueAt: dealSuggestions.dueAt,
        })
        .from(dealSuggestions)
        .where(
          and(
            eq(dealSuggestions.id, suggestionId),
            eq(dealSuggestions.accountId, ctx.accountId),
            eq(dealSuggestions.status, 'pending'),
          ),
        )
        .limit(1),
    )
    if (!sug) return { error: 'Sugestão não encontrada.' }

    if (sug.kind === 'task') {
      // Follow-up: cria a tarefa (value=título, evidence=motivo, dueAt=quando),
      // atribuída ao dono do negócio.
      const deal = await getDeal(sug.dealId)
      const res = await createTask({
        title: sug.value,
        description: sug.evidence
          ? `Sugerido pela IA — motivo: ${sug.evidence}`
          : 'Sugerido pela IA.',
        dueAt: sug.dueAt,
        type: 'follow_up',
        dealId: sug.dealId,
        contactId: deal?.contact_id ?? null,
        assigneeIds: deal?.assigned_to ? [deal.assigned_to] : [],
      })
      if (!res.ok) return { error: res.error }
    } else if (sug.kind === 'message') {
      // Fallback (aceitar direto, sem editar): agenda com o texto/horário
      // sugeridos. O fluxo normal usa scheduleDealSuggestion (confirma/edita).
      if (!sug.dueAt) return { error: 'Sugestão sem horário para agendar.' }
      return await scheduleSuggestedMessage(ctx, sug, sug.value, sug.dueAt)
    } else if (sug.target === 'deal:temperature') {
      await updateDeal(sug.dealId, { temperature: sug.value })
    } else if (sug.target === 'deal:qualification') {
      await updateDeal(sug.dealId, { qualification: parseInt(sug.value, 10) })
    } else if (sug.target === 'deal:value') {
      await updateDeal(sug.dealId, { value: Number(sug.value) })
    } else if (sug.target === 'deal:notes') {
      await updateDeal(sug.dealId, { notes: sug.value })
    } else if (sug.target.startsWith('custom:')) {
      const fieldId = sug.target.slice('custom:'.length)
      const deal = await getDeal(sug.dealId)
      if (!deal?.contact_id) return { error: 'Negócio sem contato para preencher.' }
      // Mescla com os valores atuais (saveContactCustomValues substitui TUDO).
      const existing = await listContactCustomValues(deal.contact_id).catch(
        () => [],
      )
      const map: Record<string, string> = {}
      for (const row of existing) map[row.custom_field_id] = row.value ?? ''
      map[fieldId] = sug.value
      const { error } = await saveContactCustomValues(deal.contact_id, map)
      if (error) return { error }
    } else {
      return { error: 'Tipo de sugestão desconhecido.' }
    }

    await db
      .update(dealSuggestions)
      .set({ status: 'accepted' })
      .where(eq(dealSuggestions.id, suggestionId))
    await recordDealEvent(ctx.accountId, ctx.userId, sug.dealId, 'note', {
      text:
        sug.kind === 'task'
          ? `IA criou follow-up: ${sug.value}`
          : `IA preencheu "${sug.label}": ${sug.value}`,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao aceitar.' }
  }
}

/** Confirma uma sugestão de MENSAGEM: agenda o texto (possivelmente editado)
 *  para o horário confirmado. A UI abre um editor antes de chamar isto, então o
 *  humano SEMPRE revê a mensagem e o horário antes de virar agendamento. */
export async function scheduleDealSuggestion(
  suggestionId: string,
  input: { text: string; scheduledAt: string },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const sug = firstOrNull(
      await db
        .select({
          id: dealSuggestions.id,
          dealId: dealSuggestions.dealId,
          kind: dealSuggestions.kind,
        })
        .from(dealSuggestions)
        .where(
          and(
            eq(dealSuggestions.id, suggestionId),
            eq(dealSuggestions.accountId, ctx.accountId),
            eq(dealSuggestions.status, 'pending'),
          ),
        )
        .limit(1),
    )
    if (!sug) return { error: 'Sugestão não encontrada.' }
    if (sug.kind !== 'message') {
      return { error: 'Esta sugestão não é uma mensagem agendável.' }
    }
    return await scheduleSuggestedMessage(
      ctx,
      { id: sug.id, dealId: sug.dealId },
      input.text,
      input.scheduledAt,
    )
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao agendar.' }
  }
}

/** Descarta uma sugestão (marca 'dismissed'). */
export async function dismissDealSuggestion(
  suggestionId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(dealSuggestions)
      .set({ status: 'dismissed' })
      .where(
        and(
          eq(dealSuggestions.id, suggestionId),
          eq(dealSuggestions.accountId, ctx.accountId),
        ),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao descartar.' }
  }
}

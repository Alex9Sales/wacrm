'use server'

// ============================================================
// Central de Mensagens Agendadas — lista global + contadores + reatribuir +
// retry. Visibilidade por papel:
//   - admin/owner: TODAS as agendadas da conta.
//   - supervisor: as suas + as dos agentes do seu setor.
//   - agent/viewer: só as suas (responsável OU criador).
// A visibilidade usa `assigned_to` (responsável = dono do lead) + `created_by`.
// ============================================================

import { and, desc, eq, inArray, ilike, or, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  db,
  scheduledMessages,
  conversations,
  contacts,
  channels,
  deals,
  sectorMembers,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { getUserSectorIds } from '@/lib/sectors/access'
import { notifyScheduledAssignee } from '@/lib/scheduled/notify'
import {
  enqueueScheduledMessage,
  removeScheduledMessageJob,
} from '@/lib/queue/queues'

export type SchedStatus = 'pending' | 'sent' | 'cancelled' | 'failed'

export interface ScheduledRow {
  id: string
  conversation_id: string
  contact_name: string | null
  contact_phone: string | null
  channel_provider: string | null
  message_type: string
  content_text: string | null
  scheduled_at: string
  status: SchedStatus
  last_error: string | null
  created_at: string
  created_by: string | null
  created_by_name: string | null
  assigned_to: string | null
  assigned_to_name: string | null
  assigned_by: string | null
  assigned_by_name: string | null
}

export interface SchedCounts {
  pending: number
  sent: number
  cancelled: number
  failed: number
}

/**
 * Conjunto de user ids que o usuário atual PODE ver (como responsável). `null`
 * = admin/owner (vê tudo). Supervisor = ele + colegas de setor. Agente = só ele.
 */
async function visibleUserIds(ctx: {
  role: string
  userId: string
  accountId: string
}): Promise<string[] | null> {
  if (hasMinRole(ctx.role as never, 'admin')) return null
  if (ctx.role === 'supervisor') {
    const sectorIds = await getUserSectorIds(ctx.userId).catch(() => [])
    const ids = new Set<string>([ctx.userId])
    if (sectorIds.length > 0) {
      const rows = await db
        .select({ userId: sectorMembers.userId })
        .from(sectorMembers)
        .where(inArray(sectorMembers.sectorId, sectorIds))
      for (const r of rows) ids.add(r.userId)
    }
    return [...ids]
  }
  return [ctx.userId]
}

/** Filtro de visibilidade (SQL) sobre scheduled_messages, por papel. */
function visibilityWhere(visible: string[] | null, userId: string) {
  if (visible === null) return undefined // admin: sem restrição
  // responsável visível OU eu criei.
  return or(
    inArray(scheduledMessages.assignedTo, visible),
    eq(scheduledMessages.createdBy, userId),
  )
}

const nameSub = (col: string) =>
  sql<string | null>`(SELECT u.name FROM "user" u WHERE u.id = "scheduled_messages"."${sql.raw(col)}")`

/** Lista as agendadas visíveis, com filtros de status/responsável/busca. */
export async function listScheduled(input: {
  status?: SchedStatus | 'all'
  assignedTo?: string
  search?: string
} = {}): Promise<ScheduledRow[]> {
  const ctx = await getCurrentAccount()
  const visible = await visibleUserIds(ctx)

  const where = [eq(scheduledMessages.accountId, ctx.accountId)]
  const vis = visibilityWhere(visible, ctx.userId)
  if (vis) where.push(vis)
  if (input.status && input.status !== 'all')
    where.push(eq(scheduledMessages.status, input.status))
  if (input.assignedTo)
    where.push(eq(scheduledMessages.assignedTo, input.assignedTo))
  const term = (input.search ?? '').trim()
  if (term)
    where.push(
      or(
        ilike(contacts.name, `%${term}%`),
        ilike(contacts.phone, `%${term}%`),
        ilike(scheduledMessages.contentText, `%${term}%`),
      )!,
    )

  const rows = await db
    .select({
      id: scheduledMessages.id,
      conversation_id: scheduledMessages.conversationId,
      contact_name: contacts.name,
      contact_phone: contacts.phone,
      channel_provider: channels.provider,
      message_type: scheduledMessages.messageType,
      content_text: scheduledMessages.contentText,
      scheduled_at: scheduledMessages.scheduledAt,
      status: scheduledMessages.status,
      last_error: scheduledMessages.lastError,
      created_at: scheduledMessages.createdAt,
      created_by: scheduledMessages.createdBy,
      created_by_name: nameSub('created_by'),
      assigned_to: scheduledMessages.assignedTo,
      assigned_to_name: nameSub('assigned_to'),
      assigned_by: scheduledMessages.assignedBy,
      assigned_by_name: nameSub('assigned_by'),
    })
    .from(scheduledMessages)
    .leftJoin(conversations, eq(scheduledMessages.conversationId, conversations.id))
    .leftJoin(contacts, eq(scheduledMessages.contactId, contacts.id))
    .leftJoin(channels, eq(conversations.channelId, channels.id))
    .where(and(...where))
    // pendentes primeiro (mais próximas no topo); resto por mais recente.
    .orderBy(
      sql`CASE WHEN ${scheduledMessages.status} = 'pending' THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${scheduledMessages.status} = 'pending' THEN ${scheduledMessages.scheduledAt} END ASC`,
      desc(scheduledMessages.scheduledAt),
    )
    .limit(500)

  return rows.map((r) => ({
    ...r,
    status: r.status as SchedStatus,
    contact_name: (r.contact_name as string | null) ?? null,
    content_text: (r.content_text as string | null) ?? null,
  })) as ScheduledRow[]
}

/** Contadores por status (respeitando a visibilidade). */
export async function getScheduledCounts(): Promise<SchedCounts> {
  const ctx = await getCurrentAccount()
  const visible = await visibleUserIds(ctx)
  const where = [eq(scheduledMessages.accountId, ctx.accountId)]
  const vis = visibilityWhere(visible, ctx.userId)
  if (vis) where.push(vis)
  const rows = await db
    .select({
      status: scheduledMessages.status,
      n: sql<number>`count(*)::int`,
    })
    .from(scheduledMessages)
    .where(and(...where))
    .groupBy(scheduledMessages.status)
  const out: SchedCounts = { pending: 0, sent: 0, cancelled: 0, failed: 0 }
  for (const r of rows) {
    const s = r.status as SchedStatus
    if (s in out) out[s] = Number(r.n ?? 0)
  }
  return out
}

/**
 * Reatribui a responsabilidade de uma agendada a outro membro (admin/supervisor).
 * Registra quem atribuiu e NOTIFICA o novo responsável (mostra criador + quem
 * atribuiu). Só mexe em quem o usuário pode ver.
 */
export async function reassignScheduled(
  id: string,
  newAssignee: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('supervisor')
    const rowId = id?.trim()
    if (!rowId || !newAssignee) return { error: 'Dados inválidos.' }
    const sm = firstOrNull(
      await db
        .select({
          id: scheduledMessages.id,
          createdBy: scheduledMessages.createdBy,
          conversationId: scheduledMessages.conversationId,
          contactId: scheduledMessages.contactId,
        })
        .from(scheduledMessages)
        .where(
          and(
            eq(scheduledMessages.id, rowId),
            eq(scheduledMessages.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!sm) return { error: 'Agendamento não encontrado.' }

    await db
      .update(scheduledMessages)
      .set({
        assignedTo: newAssignee,
        assignedBy: ctx.userId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(scheduledMessages.id, rowId))

    await notifyScheduledAssignee({
      accountId: ctx.accountId,
      assignee: newAssignee,
      actorId: ctx.userId,
      createdBy: sm.createdBy,
      conversationId: sm.conversationId,
      contactId: sm.contactId,
    })
    revalidatePath('/agendamentos')
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao reatribuir.' }
  }
}

/** Reenvia uma agendada que FALHOU: volta a 'pending' daqui a ~1 min e reenfileira. */
export async function retryScheduled(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    const rowId = id?.trim()
    if (!rowId) return { error: 'Agendamento inválido.' }
    const sm = firstOrNull(
      await db
        .select({ id: scheduledMessages.id, status: scheduledMessages.status })
        .from(scheduledMessages)
        .where(
          and(
            eq(scheduledMessages.id, rowId),
            eq(scheduledMessages.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!sm) return { error: 'Agendamento não encontrado.' }
    if (sm.status !== 'failed')
      return { error: 'Só dá para reenviar mensagens que falharam.' }

    const delayMs = 60_000
    const when = new Date(Date.now() + delayMs).toISOString()
    await db
      .update(scheduledMessages)
      .set({
        status: 'pending',
        scheduledAt: when,
        lastError: null,
        attempts: 0,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(scheduledMessages.id, rowId))
    try {
      await removeScheduledMessageJob(rowId)
      await enqueueScheduledMessage(rowId, { delayMs })
    } catch {
      return { error: 'Não foi possível reenfileirar (fila indisponível).' }
    }
    revalidatePath('/agendamentos')
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao reenviar.' }
  }
}


// ------------------------------------------------------------
// Agendar mensagem a partir desta tela: busca de negócios (funil) com o
// contato/telefone, pra abrir/achar a conversa e agendar a mensagem.
// (Contatos usam listContacts; canais usam listSendableChannels.)
// ------------------------------------------------------------

export type DealPick = {
  id: string
  title: string
  contactId: string | null
  contactName: string | null
  contactPhone: string | null
}

/** Negócios cujo título OU contato casa com a busca — só os que têm telefone
 *  (pois agendar exige uma conversa, resolvida pelo telefone do contato). */
export async function searchDealsForSchedule(query: string): Promise<DealPick[]> {
  const ctx = await getCurrentAccount()
  const q = query.trim()
  if (!q) return []
  const like = `%${q}%`
  const rows = await db
    .select({
      id: deals.id,
      title: deals.title,
      contactId: deals.contactId,
      contactName: contacts.name,
      contactPhone: contacts.phone,
    })
    .from(deals)
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .where(
      and(
        eq(deals.accountId, ctx.accountId),
        or(ilike(deals.title, like), ilike(contacts.name, like)),
      ),
    )
    .orderBy(desc(deals.createdAt))
    .limit(8)
  return rows.filter((r) => r.contactPhone) as DealPick[]
}

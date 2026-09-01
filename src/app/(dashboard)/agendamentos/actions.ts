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
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

export type SchedStatus = 'pending' | 'sent' | 'cancelled' | 'failed'

export interface ScheduledRow {
  id: string
  conversation_id: string
  contact_name: string | null
  contact_phone: string | null
  channel_provider: string | null
  /** Número/canal por onde a agendada sai (Rafael 01/09: ver ao lado do responsável). */
  channel_name: string | null
  channel_phone: string | null
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

/** Filtro de período (pedido do Rafael 25/08) — janela no FUSO da conta. */
export type SchedPeriod = 'all' | 'today' | 'yesterday' | '7d'

/** Lista as agendadas visíveis, com filtros de status/responsável/busca/período. */
export async function listScheduled(input: {
  status?: SchedStatus | 'all'
  assignedTo?: string
  search?: string
  period?: SchedPeriod
} = {}): Promise<ScheduledRow[]> {
  const ctx = await getCurrentAccount()
  const visible = await visibleUserIds(ctx)

  const where = [eq(scheduledMessages.accountId, ctx.accountId)]
  const vis = visibilityWhere(visible, ctx.userId)
  if (vis) where.push(vis)
  if (input.status && input.status !== 'all')
    where.push(eq(scheduledMessages.status, input.status))
  if (input.period && input.period !== 'all') {
    const { getAccountSettings } = await import('@/lib/settings/account-settings')
    const { startOfDayInTz } = await import('@/lib/dashboard/date-utils')
    const tz = (await getAccountSettings(ctx.accountId)).businessTimezone || 'America/Sao_Paulo'
    const tomorrowStart = startOfDayInTz(tz, -1).toISOString()
    if (input.period === 'today') {
      where.push(
        sql`${scheduledMessages.scheduledAt} >= ${startOfDayInTz(tz, 0).toISOString()}`,
        sql`${scheduledMessages.scheduledAt} < ${tomorrowStart}`,
      )
    } else if (input.period === 'yesterday') {
      where.push(
        sql`${scheduledMessages.scheduledAt} >= ${startOfDayInTz(tz, 1).toISOString()}`,
        sql`${scheduledMessages.scheduledAt} < ${startOfDayInTz(tz, 0).toISOString()}`,
      )
    } else {
      where.push(
        sql`${scheduledMessages.scheduledAt} >= ${startOfDayInTz(tz, 6).toISOString()}`,
        sql`${scheduledMessages.scheduledAt} < ${tomorrowStart}`,
      )
    }
  }
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
      channel_name: channels.name,
      channel_phone: channels.phoneNumber,
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

// ============================================================
// Número fora do ar (banido / desconectado) com agendadas presas nele.
//
// O canal de uma agendada é o canal da CONVERSA dela. Se esse número cai
// (ban do WhatsApp, logout no aparelho), tudo que estava marcado ali vira
// falha na hora do envio — silenciosamente. Estas duas ações fazem o CRM
// AVISAR e deixar a pessoa escolher outro número.
//
// Decisão de produto (Alex, 01/09): NADA de fallback automático — cair
// sozinho pra outro número pode jogar a fila num número que também está
// banido. A escolha é sempre explícita.
// ============================================================

export interface BrokenChannelSchedules {
  channel_id: string
  channel_name: string | null
  channel_status: string | null
  /** true = o número está fora do ar AGORA (nada marcado nele vai sair). */
  is_down: boolean
  /** Agendadas ainda por enviar presas nesse número (só quando is_down). */
  pending: number
  /** Falhas causadas por queda do número (sessão fora do ar na hora do envio). */
  failed: number
  /** Data da falha mais antiga — pra pessoa saber se ainda faz sentido reenviar. */
  failed_oldest: string | null
}

/**
 * Erro de envio que veio de NÚMERO FORA DO AR (e não de conteúdo/destinatário).
 * É o texto que o WAHA devolve quando a sessão caiu — foi o que matou 200+
 * agendadas em silêncio antes deste aviso existir.
 */
const DOWN_ERROR_SQL = sql`(
  ${scheduledMessages.lastError} ILIKE '%session status%'
  OR ${scheduledMessages.lastError} ILIKE '%not connected%'
  OR ${scheduledMessages.lastError} ILIKE '%desconect%'
)`

/**
 * Números com agendadas travadas — nos DOIS cenários:
 *   (a) o número está fora do ar agora → o que está marcado nele não vai sair;
 *   (b) o número já voltou, mas ficaram falhas de quando ele estava fora.
 * O (b) é o silencioso: a mensagem morreu, o número voltou, e ninguém viu.
 */
export async function listBrokenChannelSchedules(): Promise<
  BrokenChannelSchedules[]
> {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        channel_id: channels.id,
        channel_name: channels.name,
        channel_status: channels.status,
        pending: sql<number>`count(*) FILTER (WHERE ${scheduledMessages.status} = 'pending' AND ${channels.status} <> 'connected')::int`,
        failed: sql<number>`count(*) FILTER (WHERE ${scheduledMessages.status} = 'failed' AND ${DOWN_ERROR_SQL})::int`,
        failed_oldest: sql<
          string | null
        >`min(${scheduledMessages.scheduledAt}) FILTER (WHERE ${scheduledMessages.status} = 'failed' AND ${DOWN_ERROR_SQL})`,
      })
      .from(scheduledMessages)
      .innerJoin(
        conversations,
        eq(scheduledMessages.conversationId, conversations.id),
      )
      .innerJoin(channels, eq(conversations.channelId, channels.id))
      .where(
        and(
          eq(scheduledMessages.accountId, ctx.accountId),
          inArray(scheduledMessages.status, ['pending', 'failed']),
        ),
      )
      .groupBy(channels.id, channels.name, channels.status)
    return rows
      .map((r) => ({ ...r, is_down: r.channel_status !== 'connected' }))
      .filter((r) => r.pending > 0 || r.failed > 0)
  } catch (err) {
    console.error('[agendamentos] listBrokenChannelSchedules falhou:', err)
    return []
  }
}

/**
 * Move as agendadas de um número que caiu para OUTRO número escolhido.
 *
 * Como o canal vem da conversa, mover = reancorar cada agendada na conversa
 * do mesmo contato no canal novo (criada se não existir). As pendentes
 * mantêm o job da fila (o worker relê a linha e já sai pelo canal novo).
 *
 * As que já FALHARAM (e as pendentes com horário vencido) voltam pra fila
 * ESPAÇADAS — 1 a cada ~75s. Soltar 50 mensagens de uma vez num número que
 * acabou de assumir é receita de tomar outro ban.
 */
export async function reassignScheduledChannel(input: {
  fromChannelId: string
  toChannelId: string
  includeFailed?: boolean
}): Promise<{ ok: true; moved: number; requeued: number } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('supervisor')
    const from = input.fromChannelId?.trim()
    const to = input.toChannelId?.trim()
    if (!from || !to) return { ok: false, error: 'Escolha o número de destino.' }
    // from === to é VÁLIDO no caso "o número voltou e ficaram falhas": aí não
    // há troca de canal, só reenvio espaçado pelo mesmo número.
    if (from === to && !input.includeFailed) {
      return { ok: false, error: 'Escolha um número diferente.' }
    }

    const target = firstOrNull(
      await db
        .select({ id: channels.id, status: channels.status })
        .from(channels)
        .where(and(eq(channels.id, to), eq(channels.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!target) return { ok: false, error: 'Número não encontrado.' }
    if (target.status !== 'connected') {
      return { ok: false, error: 'Esse número também está fora do ar.' }
    }

    // O que é elegível depende do cenário:
    //  - número de origem FORA DO AR: as pendentes (nada ali vai sair) e, se
    //    pedido, as que já falharam por causa da queda;
    //  - número de origem NO AR (só sobraram falhas da queda): apenas essas —
    //    as pendentes estão num número que funciona, não se mexe nelas.
    const source = firstOrNull(
      await db
        .select({ status: channels.status })
        .from(channels)
        .where(and(eq(channels.id, from), eq(channels.accountId, ctx.accountId)))
        .limit(1),
    )
    const sourceDown = !!source && source.status !== 'connected'
    const wanted: SchedStatus[] = sourceDown
      ? input.includeFailed
        ? ['pending', 'failed']
        : ['pending']
      : ['failed']
    const rows = await db
      .select({
        id: scheduledMessages.id,
        status: scheduledMessages.status,
        scheduledAt: scheduledMessages.scheduledAt,
        contactId: scheduledMessages.contactId,
        conversationId: scheduledMessages.conversationId,
        phone: contacts.phone,
        name: contacts.name,
      })
      .from(scheduledMessages)
      .innerJoin(
        conversations,
        eq(scheduledMessages.conversationId, conversations.id),
      )
      .leftJoin(contacts, eq(scheduledMessages.contactId, contacts.id))
      .where(
        and(
          eq(scheduledMessages.accountId, ctx.accountId),
          eq(conversations.channelId, from),
          inArray(scheduledMessages.status, wanted),
          // Falha só entra se foi por QUEDA do número. Mensagem que falhou por
          // número inválido ou janela fechada vai falhar de novo — reenviar só
          // gasta a reputação do número.
          or(
            eq(scheduledMessages.status, 'pending'),
            DOWN_ERROR_SQL,
          ),
        ),
      )
      .orderBy(scheduledMessages.scheduledAt)
      .limit(500)

    // Espaçamento anti-ban: a 1ª sai em ~1min, as demais de ~75 em ~75s.
    const SPACING_MS = 75_000
    let slot = 0
    let moved = 0
    let requeued = 0

    const sameChannel = from === to
    for (const row of rows) {
      // Reenvio pelo MESMO número não mexe na conversa — resolver de novo só
      // arriscaria criar contato/conversa duplicada por diferença de formato
      // no telefone.
      let conversationId = row.conversationId
      if (!sameChannel) {
        if (!row.phone) continue
        try {
          const resolved = await resolveConversationByPhone(
            ctx.accountId,
            row.phone,
            row.name,
            to,
          )
          conversationId = resolved.conversationId
        } catch (err) {
          console.error('[agendamentos] reancorar falhou:', row.id, err)
          continue
        }
      }

      const dueMs = new Date(row.scheduledAt as string).getTime()
      const isLate = !Number.isFinite(dueMs) || dueMs <= Date.now()
      const needsRequeue = row.status === 'failed' || isLate
      const nextAt = needsRequeue
        ? new Date(Date.now() + 60_000 + slot * SPACING_MS)
        : new Date(dueMs)

      await db
        .update(scheduledMessages)
        .set({
          conversationId,
          ...(needsRequeue
            ? {
                status: 'pending' as const,
                scheduledAt: nextAt.toISOString(),
                lastError: null,
                attempts: 0,
              }
            : {}),
        })
        .where(
          and(
            eq(scheduledMessages.id, row.id),
            eq(scheduledMessages.accountId, ctx.accountId),
          ),
        )
      moved += 1

      if (needsRequeue) {
        // Solta o job velho (se sobrou) e reagenda no horário espaçado.
        try {
          await removeScheduledMessageJob(row.id)
        } catch {
          /* job já não existe — segue */
        }
        try {
          await enqueueScheduledMessage(row.id, {
            delayMs: Math.max(nextAt.getTime() - Date.now(), 1_000),
          })
          requeued += 1
          slot += 1
        } catch (err) {
          console.error('[agendamentos] reenfileirar falhou:', row.id, err)
          await db
            .update(scheduledMessages)
            .set({ status: 'failed', lastError: 'fila indisponível' })
            .where(eq(scheduledMessages.id, row.id))
        }
      }
    }

    revalidatePath('/agendamentos')
    return { ok: true, moved, requeued }
  } catch (err) {
    console.error('[agendamentos] reassignScheduledChannel falhou:', err)
    return { ok: false, error: 'Falha ao trocar o número das agendadas.' }
  }
}

'use server'

// ============================================================
// Server actions for scheduled messages ("Agendar mensagem" — inbox
// sidebar). Every query is account-scoped via getCurrentAccount /
// requireRole (no RLS). A scheduled message is a 1:1 WhatsApp message
// queued to fire at a future instant:
//
//   scheduleMessage  → validate + insert (status 'pending') + enqueue a
//                      delayed BullMQ job (delay = scheduled_at - now).
//   listScheduledMessages → this conversation's schedule (pending first).
//   cancelScheduledMessage → flip 'pending' → 'cancelled' + drop the job.
//
// The worker (src/worker/scheduled-message-worker.ts) does the actual
// send at the scheduled time via the shared send funnel.
// ============================================================

import { and, desc, eq, or, sql } from 'drizzle-orm'

import { db, scheduledMessages, conversations } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { notifyScheduledAssignee } from '@/lib/scheduled/notify'
import {
  enqueueScheduledMessage,
  removeScheduledMessageJob,
} from '@/lib/queue/queues'

export type ScheduledMessageStatus = 'pending' | 'sent' | 'cancelled' | 'failed'

/** One scheduled-message row for the sidebar list (snake_case). */
export interface ScheduledMessageLite {
  id: string
  conversation_id: string
  message_type: string
  content_text: string | null
  scheduled_at: string
  status: ScheduledMessageStatus
  last_error: string | null
  created_at: string
}

export interface ScheduleMessageInput {
  conversationId: string
  contentText: string
  /** Absolute instant (ISO 8601, e.g. from `new Date(local).toISOString()`). */
  scheduledAt: string
  /** Responsável explícito (picker admin/supervisor). Vazio = herda o dono do lead. */
  assignedTo?: string | null
}

const liteSelect = {
  id: scheduledMessages.id,
  conversation_id: scheduledMessages.conversationId,
  message_type: scheduledMessages.messageType,
  content_text: scheduledMessages.contentText,
  scheduled_at: scheduledMessages.scheduledAt,
  status: scheduledMessages.status,
  last_error: scheduledMessages.lastError,
  created_at: scheduledMessages.createdAt,
}

function toLite(r: Record<string, unknown>): ScheduledMessageLite {
  return {
    id: r.id as string,
    conversation_id: r.conversation_id as string,
    message_type: r.message_type as string,
    content_text: (r.content_text as string | null) ?? null,
    scheduled_at: r.scheduled_at as string,
    status: r.status as ScheduledMessageStatus,
    last_error: (r.last_error as string | null) ?? null,
    created_at: r.created_at as string,
  }
}

/**
 * A conversation's schedule (account-scoped): pending first (soonest due),
 * then the most recent settled ones. Powers the sidebar section.
 */
export async function listScheduledMessages(
  conversationId: string,
): Promise<ScheduledMessageLite[]> {
  const ctx = await getCurrentAccount()
  const id = conversationId?.trim()
  if (!id) return []
  const rows = await db
    .select(liteSelect)
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.accountId, ctx.accountId),
        eq(scheduledMessages.conversationId, id),
      ),
    )
    // pending first, then by soonest scheduled time.
    .orderBy(
      sql`CASE WHEN ${scheduledMessages.status} = 'pending' THEN 0 ELSE 1 END`,
      scheduledMessages.scheduledAt,
      desc(scheduledMessages.createdAt),
    )
    .limit(50)
  return rows.map((r) => toLite(r as Record<string, unknown>))
}

/**
 * Quantas mensagens PENDENTES a conta já tem agendadas pro MESMO dia (fuso
 * America/Sao_Paulo) do instante informado. Alimenta o aviso anti-ban de "já tem
 * 30+ nesse dia" na tela de Nova mensagem.
 */
export async function countScheduledPendingOnDay(
  scheduledAtISO: string,
): Promise<number> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledMessages)
    .where(
      and(
        eq(scheduledMessages.accountId, ctx.accountId),
        eq(scheduledMessages.status, 'pending'),
        sql`(${scheduledMessages.scheduledAt} AT TIME ZONE 'America/Sao_Paulo')::date = (${scheduledAtISO}::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date`,
      ),
    )
  return rows[0]?.n ?? 0
}

/**
 * Schedule a text message into a conversation. Validates ownership + a
 * future instant, inserts the row, and enqueues the delayed job. If the
 * enqueue fails the row is rolled back so we never leave a pending row
 * with no job behind it.
 */
export async function scheduleMessage(
  input: ScheduleMessageInput,
): Promise<
  { ok: true; scheduled: ScheduledMessageLite } | { ok: false; error: string }
> {
  try {
    const ctx = await requireRole('agent')

    const conversationId = input.conversationId?.trim()
    const contentText = input.contentText?.trim()
    if (!conversationId) return { ok: false, error: 'Conversa inválida.' }
    if (!contentText) return { ok: false, error: 'Escreva a mensagem.' }

    const when = new Date(input.scheduledAt)
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: 'Data/hora inválida.' }
    }
    const delayMs = when.getTime() - Date.now()
    // Require at least ~30s in the future so a same-minute pick isn't
    // effectively "send now" and to leave room for clock skew.
    if (delayMs < 30_000) {
      return { ok: false, error: 'Escolha um horário pelo menos 1 min à frente.' }
    }

    // Ownership + denormalized contact + responsável (dono do lead), account-scoped.
    let conv:
      | { id: string; contactId: string; assignedAgentId: string | null }
      | null = null
    try {
      conv = firstOrNull(
        await db
          .select({
            id: conversations.id,
            contactId: conversations.contactId,
            assignedAgentId: conversations.assignedAgentId,
          })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      )
    } catch {
      conv = null
    }
    if (!conv) return { ok: false, error: 'Conversa não encontrada.' }

    // Responsável pela agendada = quem foi passado explicitamente (picker do
    // admin/supervisor), senão o dono atual do lead, senão o próprio criador.
    const assignedTo =
      input.assignedTo?.trim() || conv.assignedAgentId || ctx.userId

    const inserted = firstOrThrow(
      await db
        .insert(scheduledMessages)
        .values({
          accountId: ctx.accountId,
          conversationId: conv.id,
          contactId: conv.contactId,
          messageType: 'text',
          contentText,
          scheduledAt: when.toISOString(),
          status: 'pending',
          createdBy: ctx.userId,
          assignedTo,
          assignedBy: ctx.userId,
        })
        .returning(liteSelect),
    )

    try {
      await enqueueScheduledMessage(inserted.id, { delayMs })
    } catch (err) {
      // Roll back so no orphan pending row lingers without a job.
      await db
        .delete(scheduledMessages)
        .where(eq(scheduledMessages.id, inserted.id))
      console.error('[schedule] enqueue failed:', err)
      return { ok: false, error: 'Não foi possível agendar (fila indisponível).' }
    }

    // Se o responsável não é quem criou, avisa ele (mostra criador + atribuidor).
    await notifyScheduledAssignee({
      accountId: ctx.accountId,
      assignee: assignedTo,
      actorId: ctx.userId,
      createdBy: ctx.userId,
      conversationId: conv.id,
      contactId: conv.contactId,
    })

    return { ok: true, scheduled: toLite(inserted as Record<string, unknown>) }
  } catch (err) {
    console.error('[schedule] scheduleMessage failed:', err)
    return { ok: false, error: 'Falha ao agendar a mensagem.' }
  }
}

/**
 * Cancel a pending scheduled message: flip 'pending' → 'cancelled' (only
 * if still pending — a race with the worker that already sent it is a
 * no-op) and drop its delayed job.
 */
export async function cancelScheduledMessage(
  id: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    const rowId = id?.trim()
    if (!rowId) return { error: 'Agendamento inválido.' }

    const updated = await db
      .update(scheduledMessages)
      .set({ status: 'cancelled', updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(scheduledMessages.id, rowId),
          eq(scheduledMessages.accountId, ctx.accountId),
          eq(scheduledMessages.status, 'pending'),
        ),
      )
      .returning({ id: scheduledMessages.id })

    // Best-effort: drop the delayed job. Even if the row was already sent
    // (update matched nothing), removing a non-existent job is harmless.
    await removeScheduledMessageJob(rowId)

    if (updated.length === 0) {
      return { error: 'Este agendamento já foi enviado ou cancelado.' }
    }
    return { error: null }
  } catch (err) {
    console.error('[schedule] cancelScheduledMessage failed:', err)
    return { error: 'Falha ao cancelar o agendamento.' }
  }
}

/**
 * Edita um agendamento AINDA pendente: muda o texto e/ou o horário. O worker
 * lê o `content_text` do banco na hora do envio, então uma edição SÓ de texto
 * não precisa re-agendar o job; quando o HORÁRIO muda, o job é dropado e
 * re-enfileirado com o novo atraso.
 */
export async function updateScheduledMessage(
  id: string,
  input: { contentText?: string; scheduledAt?: string },
): Promise<
  { ok: true; scheduled: ScheduledMessageLite } | { ok: false; error: string }
> {
  try {
    const ctx = await requireRole('agent')
    const rowId = id?.trim()
    if (!rowId) return { ok: false, error: 'Agendamento inválido.' }

    const set: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    }
    let delayMs: number | null = null

    if (input.contentText !== undefined) {
      const t = input.contentText.trim()
      if (!t) return { ok: false, error: 'Escreva a mensagem.' }
      set.contentText = t
    }
    if (input.scheduledAt !== undefined) {
      const when = new Date(input.scheduledAt)
      if (Number.isNaN(when.getTime())) {
        return { ok: false, error: 'Data/hora inválida.' }
      }
      delayMs = when.getTime() - Date.now()
      if (delayMs < 30_000) {
        return {
          ok: false,
          error: 'Escolha um horário pelo menos 1 min à frente.',
        }
      }
      set.scheduledAt = when.toISOString()
    }

    const updated = firstOrNull(
      await db
        .update(scheduledMessages)
        .set(set)
        .where(
          and(
            eq(scheduledMessages.id, rowId),
            eq(scheduledMessages.accountId, ctx.accountId),
            eq(scheduledMessages.status, 'pending'),
          ),
        )
        .returning(liteSelect),
    )
    if (!updated) {
      return {
        ok: false,
        error: 'Este agendamento já foi enviado ou cancelado.',
      }
    }

    // Só re-agenda o job quando o HORÁRIO mudou (conteúdo é lido do banco).
    if (delayMs !== null) {
      await removeScheduledMessageJob(rowId)
      try {
        await enqueueScheduledMessage(rowId, { delayMs })
      } catch (err) {
        console.error('[schedule] re-enqueue failed:', err)
        return {
          ok: false,
          error: 'Não foi possível reagendar (fila indisponível).',
        }
      }
    }

    return { ok: true, scheduled: toLite(updated as Record<string, unknown>) }
  } catch (err) {
    console.error('[schedule] updateScheduledMessage failed:', err)
    return { ok: false, error: 'Falha ao editar o agendamento.' }
  }
}

/**
 * Agendadas de um CONTATO (não só de uma conversa): via contact_id da própria
 * agendada OU via o contato da conversa. Alimenta a seção "Mensagens agendadas"
 * na tela de detalhe do contato. Pendentes primeiro.
 */
export async function listScheduledForContact(
  contactId: string,
): Promise<ScheduledMessageLite[]> {
  const ctx = await getCurrentAccount()
  const cid = contactId?.trim()
  if (!cid) return []
  const rows = await db
    .select(liteSelect)
    .from(scheduledMessages)
    .leftJoin(conversations, eq(scheduledMessages.conversationId, conversations.id))
    .where(
      and(
        eq(scheduledMessages.accountId, ctx.accountId),
        or(
          eq(scheduledMessages.contactId, cid),
          eq(conversations.contactId, cid),
        ),
      ),
    )
    .orderBy(
      sql`CASE WHEN ${scheduledMessages.status} = 'pending' THEN 0 ELSE 1 END`,
      scheduledMessages.scheduledAt,
      desc(scheduledMessages.createdAt),
    )
    .limit(50)
  return rows.map((r) => toLite(r as Record<string, unknown>))
}

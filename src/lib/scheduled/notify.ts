// Notificação de "mensagem agendada atribuída a você". Módulo puro (SEM
// 'use server') — usado pela criação (scheduleMessage) e pela reatribuição
// (reassignScheduled), sem virar um endpoint RPC público.

import { sql } from 'drizzle-orm'

import { db, notifications } from '@/db'
import { firstOrNull } from '@/db/helpers'

async function userName(id: string | null): Promise<string> {
  if (!id) return 'Alguém'
  const r = firstOrNull(
    await db
      .select({ name: sql<string | null>`name` })
      .from(sql`"user"`)
      .where(sql`id = ${id}`)
      .limit(1),
  )
  return r?.name ?? 'Alguém'
}

/**
 * Notifica o responsável de uma mensagem agendada quando ele NÃO é o ator
 * (quem criou/atribuiu). O corpo mostra quem criou e quem atribuiu.
 * Best-effort: falha aqui nunca quebra o fluxo de agendamento.
 */
export async function notifyScheduledAssignee(args: {
  accountId: string
  assignee: string
  actorId: string
  createdBy: string | null
  conversationId: string
  contactId: string | null
}): Promise<void> {
  if (!args.assignee || args.assignee === args.actorId) return
  try {
    const actorName = await userName(args.actorId)
    const body =
      args.createdBy && args.createdBy !== args.actorId
        ? `${await userName(args.createdBy)} criou uma mensagem agendada e ${actorName} atribuiu a você.`
        : `${actorName} agendou uma mensagem e atribuiu a você.`
    await db.insert(notifications).values({
      accountId: args.accountId,
      userId: args.assignee,
      type: 'scheduled_message_assigned',
      conversationId: args.conversationId,
      contactId: args.contactId,
      actorUserId: args.actorId,
      title: 'Mensagem agendada atribuída a você',
      body,
    })
  } catch (err) {
    console.error('[scheduled] notify failed:', err)
  }
}

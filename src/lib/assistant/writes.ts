// ============================================================
// 🤝 Assistente do dono — ESCRITAS (banco). Espelham o núcleo das server
// actions de Tarefas, Funil e Agenda, sem sessão (o dono foi identificado
// pelo telefone). Só rodam depois do SIM. Worker-reachable.
// ============================================================

import { and, asc, eq } from 'drizzle-orm'

import { db, calendarEvents, calendars, contacts, conversations, dealEvents, deals, notifications, tasks, user } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { publishEvent } from '@/lib/events/publish'
import { notifyUsers } from '@/lib/orchestration/actions'

async function nameOf(userId: string | null): Promise<string | null> {
  if (!userId) return null
  const u = firstOrNull(await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1))
  return u?.name?.trim() || null
}

export async function createTaskCore(args: {
  accountId: string
  userId: string
  title: string
  dueAt: string | null
  assigneeId: string | null
  contactId: string | null
  dealId: string | null
}): Promise<string> {
  const inserted = await db
    .insert(tasks)
    .values({
      accountId: args.accountId,
      title: args.title.trim().slice(0, 200),
      dueAt: args.dueAt,
      status: 'open',
      contactId: args.contactId,
      dealId: args.dealId,
      assignedTo: args.assigneeId ?? null,
      assigneeIds: args.assigneeId ? [args.assigneeId] : [],
      createdBy: args.userId,
    })
    .returning({ id: tasks.id })
  const id = firstOrThrow(inserted).id
  if (args.assigneeId && args.assigneeId !== args.userId) {
    await notifyUsers({
      accountId: args.accountId,
      userIds: [args.assigneeId],
      type: 'task_assigned',
      title: 'Nova tarefa para você',
      body: args.title,
      contactId: args.contactId,
      dealId: args.dealId,
    }).catch(() => 0)
  }
  return id
}

export async function transferDealCore(args: { accountId: string; actorUserId: string; dealId: string; toUserId: string }): Promise<void> {
  const row = firstOrNull(
    await db
      .select({ assignedTo: deals.assignedTo, contactId: deals.contactId })
      .from(deals)
      .where(and(eq(deals.id, args.dealId), eq(deals.accountId, args.accountId)))
      .limit(1),
  )
  if (!row) throw new Error('Negócio não encontrado.')
  if (row.assignedTo === args.toUserId) return
  const [toName, byName] = await Promise.all([nameOf(args.toUserId), nameOf(args.actorUserId)])
  await db.update(deals).set({ assignedTo: args.toUserId }).where(and(eq(deals.id, args.dealId), eq(deals.accountId, args.accountId)))
  await db.insert(dealEvents).values({
    accountId: args.accountId,
    dealId: args.dealId,
    actorUserId: args.actorUserId,
    type: 'transferred',
    data: { to: toName, by: byName, by_role: 'owner', via: 'assistente' },
  })
  let contactName = 'um lead'
  if (row.contactId) {
    const c = firstOrNull(await db.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, row.contactId)).limit(1))
    contactName = c?.name?.trim() || c?.phone || contactName
  }
  if (args.toUserId !== args.actorUserId) {
    await db.insert(notifications).values({
      accountId: args.accountId,
      userId: args.toUserId,
      type: 'deal_transferred',
      dealId: args.dealId,
      contactId: row.contactId,
      actorUserId: args.actorUserId,
      title: 'Lead transferido para você',
      body: `${byName ?? 'O dono'} passou o lead "${contactName}" para você pelo assistente.`,
    })
    await publishEvent(args.accountId, { type: 'notification' }).catch(() => {})
  }
}

export async function assignConversationCore(args: { accountId: string; actorUserId: string; conversationId: string; toUserId: string }): Promise<void> {
  await db
    .update(conversations)
    .set({ assignedAgentId: args.toUserId, assignedAt: new Date().toISOString(), aiReplyCount: 0 })
    .where(and(eq(conversations.id, args.conversationId), eq(conversations.accountId, args.accountId)))
  if (args.toUserId !== args.actorUserId) {
    const byName = await nameOf(args.actorUserId)
    await db.insert(notifications).values({
      accountId: args.accountId,
      userId: args.toUserId,
      type: 'conversation_assigned',
      conversationId: args.conversationId,
      actorUserId: args.actorUserId,
      title: 'Conversa atribuída a você',
      body: `${byName ?? 'O dono'} passou uma conversa para você pelo assistente.`,
    })
    await publishEvent(args.accountId, { type: 'notification' }).catch(() => {})
  }
}

async function ensureDefaultCalendar(accountId: string, userId: string): Promise<string> {
  const existing = firstOrNull(await db.select({ id: calendars.id }).from(calendars).where(eq(calendars.accountId, accountId)).orderBy(asc(calendars.createdAt)).limit(1))
  if (existing) return existing.id
  const created = firstOrThrow(
    await db.insert(calendars).values({ accountId, ownerUserId: userId, createdBy: userId, name: 'Minha agenda' }).returning({ id: calendars.id }),
  )
  return created.id
}

export async function createEventCore(args: {
  accountId: string
  userId: string
  title: string
  startsAt: string
  endsAt: string
  contactId: string | null
  dealId: string | null
}): Promise<string> {
  const calendarId = await ensureDefaultCalendar(args.accountId, args.userId)
  const created = firstOrThrow(
    await db
      .insert(calendarEvents)
      .values({
        accountId: args.accountId,
        calendarId,
        ownerUserId: args.userId,
        createdBy: args.userId,
        title: args.title.trim().slice(0, 200),
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        allDay: false,
        contactId: args.contactId,
        dealId: args.dealId,
      })
      .returning({ id: calendarEvents.id }),
  )
  try {
    const { pushEventToGoogle } = await import('@/lib/google/sync')
    await pushEventToGoogle(args.accountId, created.id, 'create')
  } catch (err) {
    console.error('[assistente] agenda → google falhou:', err instanceof Error ? err.message : err)
  }
  return created.id
}

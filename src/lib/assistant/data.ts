// ============================================================
// 🤝 Assistente do dono — LEITURAS (banco). Cada função devolve dados já
// no formato que rules.ts sabe escrever. Worker-reachable.
// ============================================================

import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'

import { db, asaasCharges, calendarEvents, channels, contacts, conversations, deals, member, pipelineStages, user } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { findContactsByQuery } from '@/lib/contacts/search'

import type { AgendaEvent, CollectionsSnapshot, CustomerCard, StalledDealRow, TeamSnapshot } from './rules'

export interface Member {
  id: string
  name: string
  role: string
}

export async function membersOf(accountId: string): Promise<Member[]> {
  const rows = await db
    .select({ id: user.id, name: user.name, role: member.role })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, accountId))
    .orderBy(asc(user.name))
  return rows.map((r) => ({ id: r.id, name: (r.name ?? '').trim() || 'Sem nome', role: r.role ?? 'agent' }))
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

/** "Vitor" → membros cujo nome contém o termo (sem acento, sem caixa). */
export function matchMembers(members: Member[], query: string): Member[] {
  const q = fold(query)
  if (!q) return []
  const exactFirst = members.filter((m) => fold(m.name).split(/\s+/)[0] === q)
  if (exactFirst.length) return exactFirst
  return members.filter((m) => fold(m.name).includes(q))
}

export async function stalledDeals(accountId: string, staleDays: number): Promise<{ rows: StalledDealRow[]; total: number }> {
  const stale = sql`coalesce(${deals.stageChangedAt}, ${deals.createdAt}) < now() - make_interval(days => ${staleDays})`
  const totalRow = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'), stale)),
  )
  const rows = await db
    .select({
      title: deals.title,
      contact: contacts.name,
      stage: pipelineStages.name,
      value: deals.value,
      currency: deals.currency,
      days: sql<number>`floor(extract(epoch from now() - coalesce(${deals.stageChangedAt}, ${deals.createdAt})) / 86400)::int`,
      assignee: user.name,
    })
    .from(deals)
    .leftJoin(contacts, eq(contacts.id, deals.contactId))
    .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .leftJoin(user, eq(user.id, deals.assignedTo))
    .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'), stale))
    .orderBy(desc(deals.value))
    .limit(8)
  return {
    total: totalRow?.n ?? rows.length,
    rows: rows.map((r) => ({
      title: r.title,
      contact: r.contact?.trim() || null,
      stage: r.stage ?? null,
      value: Number(r.value ?? 0),
      currency: r.currency ?? 'BRL',
      days: Number(r.days ?? 0),
      assignee: r.assignee?.trim() || null,
    })),
  }
}

export async function customerCard(
  accountId: string,
  query: string,
): Promise<{ card: CustomerCard | null; contactId: string | null; choices: { name: string | null; phone: string }[] }> {
  const found = await findContactsByQuery(accountId, query, 5)
  if (found.length === 0) return { card: null, contactId: null, choices: [] }
  if (found.length > 1) return { card: null, contactId: null, choices: found.map((c) => ({ name: c.name, phone: c.phone })) }
  const c = found[0]
  const dealRows = await db
    .select({ title: deals.title, stage: pipelineStages.name, value: deals.value, currency: deals.currency, status: deals.status })
    .from(deals)
    .leftJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
    .where(and(eq(deals.accountId, accountId), eq(deals.contactId, c.id)))
    .orderBy(desc(deals.createdAt))
    .limit(4)
  const conv = firstOrNull(
    await db
      .select({ channel: channels.name, at: conversations.lastMessageAt, status: conversations.status })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, c.id)))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
  const charges = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${asaasCharges.value}), 0)::float` })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, c.id), eq(asaasCharges.open, true))),
  )
  return {
    contactId: c.id,
    choices: [],
    card: {
      name: c.name,
      phone: c.phone,
      email: c.email,
      deals: dealRows.map((d) => ({ title: d.title, stage: d.stage ?? null, value: Number(d.value ?? 0), currency: d.currency ?? 'BRL', status: d.status ?? null })),
      lastConversation: conv ? { channel: conv.channel ?? null, at: conv.at ?? null, status: conv.status ?? null } : null,
      openChargesCount: charges?.n ?? 0,
      openChargesTotal: Number(charges?.total ?? 0),
    },
  }
}

export async function agendaBetween(accountId: string, fromIso: string, toIso: string): Promise<AgendaEvent[]> {
  const rows = await db
    .select({ title: calendarEvents.title, startsAt: calendarEvents.startsAt, endsAt: calendarEvents.endsAt, allDay: calendarEvents.allDay, contact: contacts.name })
    .from(calendarEvents)
    .leftJoin(contacts, eq(contacts.id, calendarEvents.contactId))
    .where(and(eq(calendarEvents.accountId, accountId), eq(calendarEvents.status, 'confirmed'), gte(calendarEvents.startsAt, fromIso), lt(calendarEvents.startsAt, toIso)))
    .orderBy(asc(calendarEvents.startsAt))
    .limit(20)
  return rows.map((r) => ({ title: r.title, startsAt: r.startsAt, endsAt: r.endsAt, allDay: !!r.allDay, contact: r.contact?.trim() || null }))
}

export async function collectionsSnapshot(accountId: string, todayYmd: string): Promise<CollectionsSnapshot> {
  const open = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${asaasCharges.value}), 0)::float` })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true))),
  )
  const overdue = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${asaasCharges.value}), 0)::float` })
      .from(asaasCharges)
      .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), lt(asaasCharges.dueDate, todayYmd))),
  )
  const paid7 = firstOrNull(
    await db
      .select({ n: sql<number>`count(*)::int`, total: sql<number>`coalesce(sum(${asaasCharges.value}), 0)::float` })
      .from(asaasCharges)
      .where(
        and(
          eq(asaasCharges.accountId, accountId),
          eq(asaasCharges.open, false),
          sql`${asaasCharges.status} in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')`,
          sql`${asaasCharges.closedAt} >= now() - interval '7 days'`,
        ),
      ),
  )
  const debtors = await db
    .select({
      name: sql<string>`coalesce(max(${asaasCharges.customerName}), max(${asaasCharges.phone}), 'Sem nome')`,
      total: sql<number>`sum(${asaasCharges.value})::float`,
      days: sql<number>`max(current_date - ${asaasCharges.dueDate}::date)::int`,
    })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.open, true), lt(asaasCharges.dueDate, todayYmd)))
    .groupBy(sql`coalesce(${asaasCharges.contactId}::text, ${asaasCharges.asaasCustomerId})`)
    .orderBy(sql`sum(${asaasCharges.value}) desc`)
    .limit(5)
  return {
    openCount: open?.n ?? 0,
    openTotal: Number(open?.total ?? 0),
    overdueCount: overdue?.n ?? 0,
    overdueTotal: Number(overdue?.total ?? 0),
    paid7Count: paid7?.n ?? 0,
    paid7Total: Number(paid7?.total ?? 0),
    topDebtors: debtors.map((d) => ({ name: d.name, total: Number(d.total ?? 0), days: Number(d.days ?? 0) })),
  }
}

export async function teamSnapshot(accountId: string, startOfTodayIso: string): Promise<TeamSnapshot> {
  const members = await membersOf(accountId)
  const openByAssignee = await db
    .select({ uid: conversations.assignedAgentId, n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(and(eq(conversations.accountId, accountId), eq(conversations.status, 'open')))
    .groupBy(conversations.assignedAgentId)
  const sentRes = await db.execute(sql`
    SELECT m.sender_id AS uid, count(*)::int AS n
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.account_id = ${accountId}
      AND m.sender_type = 'agent'
      AND m.is_internal = false
      AND m.created_at >= ${startOfTodayIso}::timestamptz
    GROUP BY m.sender_id
  `)
  const sent = new Map<string, number>()
  for (const r of sentRes.rows as unknown as { uid: string | null; n: number }[]) if (r.uid) sent.set(r.uid, Number(r.n))
  const openMap = new Map<string, number>()
  for (const r of openByAssignee) if (r.uid) openMap.set(r.uid, Number(r.n))

  const waitingRes = await db.execute(sql`
    SELECT coalesce(ct.name, ct.phone) AS name,
           floor(extract(epoch FROM now() - c.last_message_at) / 60)::int AS minutes,
           u.name AS assignee
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN "user" u ON u.id = c.assigned_agent_id
    WHERE c.account_id = ${accountId}
      AND c.status = 'open'
      AND ct.is_group = false
      AND c.last_message_at < now() - interval '60 minutes'
      AND c.last_message_at > now() - interval '3 days'
      AND (SELECT m.sender_type FROM messages m WHERE m.conversation_id = c.id AND m.is_internal = false ORDER BY m.created_at DESC LIMIT 1) = 'customer'
    ORDER BY c.last_message_at ASC
    LIMIT 6
  `)
  return {
    members: members.map((m) => ({ name: m.name, openConversations: openMap.get(m.id) ?? 0, sentToday: sent.get(m.id) ?? 0 })),
    waiting: (waitingRes.rows as unknown as { name: string; minutes: number; assignee: string | null }[]).map((w) => ({
      name: w.name,
      minutes: Number(w.minutes),
      assignee: w.assignee?.trim() || null,
    })),
  }
}

/** Negócio aberto mais recente do contato (pra atribuir / puxar condições). */
export async function latestOpenDealOf(accountId: string, contactId: string) {
  return firstOrNull(
    await db
      .select({ id: deals.id, title: deals.title, assignedTo: deals.assignedTo, installments: deals.installments, paymentType: deals.paymentType, paymentMethod: deals.paymentMethod })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.contactId, contactId), eq(deals.status, 'open')))
      .orderBy(desc(deals.createdAt))
      .limit(1),
  )
}

/** Conversa aberta mais recente do contato (pra atribuir). */
export async function latestOpenConversationOf(accountId: string, contactId: string) {
  return firstOrNull(
    await db
      .select({ id: conversations.id, channel: channels.name, assignedAgentId: conversations.assignedAgentId })
      .from(conversations)
      .leftJoin(channels, eq(channels.id, conversations.channelId))
      .where(and(eq(conversations.accountId, accountId), eq(conversations.contactId, contactId), eq(conversations.status, 'open')))
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
}

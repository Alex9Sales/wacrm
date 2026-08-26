import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm'

import {
  db,
  automationLogs,
  automations,
  broadcasts,
  contacts,
  conversations,
  deals,
  messages,
  pipelineStages,
  pipelines,
} from '@/db'
import {
  daysAgoStart,
  DOW_SHORT_MON_FIRST,
  lastNDayKeys,
  mondayIndex,
  startOfDayInTz,
} from './date-utils'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  PipelineStageSlice,
  ResponseTimeBucket,
  ResponseTimeSummary,
} from './types'

// ------------------------------------------------------------
// All client-side aggregation. There is no RLS anymore, so every
// query is scoped explicitly by `accountId`. `messages` has no
// account column — it is always joined through `conversations`.
// Perf is acceptable for the current scale (low thousands of
// messages) — if a tenant's dataset outgrows this, we'd migrate the
// heavy aggregations to SQL.
// ------------------------------------------------------------

// --- 1. Metric cards ---------------------------------------------------

export async function loadMetrics(accountId: string): Promise<MetricsBundle> {
  // "Hoje" no relógio do CLIENTE (businessTimezone da conta), não no UTC.
  let tz = 'America/Sao_Paulo'
  try {
    const { getAccountSettings } = await import('@/lib/settings/account-settings')
    tz = (await getAccountSettings(accountId)).businessTimezone || tz
  } catch {
    // sem settings → padrão BR
  }
  const todayStart = startOfDayInTz(tz, 0).toISOString()
  const yesterdayStart = startOfDayInTz(tz, 1).toISOString()

  const countConversations = async (extra?: 'today' | 'yesterday') => {
    const conds = [
      eq(conversations.accountId, accountId),
      eq(conversations.status, 'open'),
    ]
    if (extra === 'today') conds.push(gte(conversations.createdAt, todayStart))
    if (extra === 'yesterday') {
      conds.push(
        gte(conversations.createdAt, yesterdayStart),
        lt(conversations.createdAt, todayStart),
      )
    }
    const [row] = await db
      .select({ n: count() })
      .from(conversations)
      .where(and(...conds))
    return row?.n ?? 0
  }

  const countContacts = async (from: string, to?: string) => {
    const conds = [eq(contacts.accountId, accountId), gte(contacts.createdAt, from)]
    if (to) conds.push(lt(contacts.createdAt, to))
    const [row] = await db
      .select({ n: count() })
      .from(contacts)
      .where(and(...conds))
    return row?.n ?? 0
  }

  const countAgentMessages = async (from: string, to?: string) => {
    // messages.account_id (migr 0111) → Index Scan direto, sem join.
    const conds = [
      eq(messages.accountId, accountId),
      eq(messages.senderType, 'agent'),
      gte(messages.createdAt, from),
    ]
    if (to) conds.push(lt(messages.createdAt, to))
    const [row] = await db.select({ n: count() }).from(messages).where(and(...conds))
    return row?.n ?? 0
  }

  const [
    openConvCur,
    newConvToday,
    newConvYesterday,
    newContactsToday,
    newContactsYesterday,
    openDealsRows,
    messagesToday,
    messagesYesterday,
  ] = await Promise.all([
    countConversations(),
    countConversations('today'),
    countConversations('yesterday'),
    countContacts(todayStart),
    countContacts(yesterdayStart, todayStart),
    db
      .select({ value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'))),
    countAgentMessages(todayStart),
    countAgentMessages(yesterdayStart, todayStart),
  ])

  const openDealsValue = openDealsRows.reduce(
    (sum, d) => sum + Number(d.value ?? 0),
    0,
  )

  return {
    activeConversations: {
      current: openConvCur,
      // "vs yesterday" on a current-state count has no clean answer
      // without snapshots — we show the delta in NEW open conversations
      // today vs yesterday. That's the business-meaningful daily signal.
      previous: newConvToday - newConvYesterday,
    },
    newContactsToday: {
      current: newContactsToday,
      previous: newContactsYesterday,
    },
    openDealsValue,
    openDealsCount: openDealsRows.length,
    messagesSentToday: {
      current: messagesToday,
      previous: messagesYesterday,
    },
  }
}

// --- 2. Conversations over time ---------------------------------------

export async function loadConversationsSeries(
  accountId: string,
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const start = daysAgoStart(rangeDays - 1).toISOString()
  // Agrega POR DIA no SQL (antes trazia TODAS as mensagens do período — 38k+ em
  // 30 dias numa conta movimentada — e contava no JS). O container roda em UTC,
  // então o dia UTC casa exatamente com o localDayKey (getDate em processo UTC).
  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${messages.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
      incoming: sql<boolean>`(${messages.senderType} = 'customer')`,
      n: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), gte(messages.createdAt, start)))
    .groupBy(sql`1, 2`)

  const keys = lastNDayKeys(rangeDays)
  const buckets = new Map<string, { incoming: number; outgoing: number }>()
  for (const k of keys) buckets.set(k, { incoming: 0, outgoing: 0 })

  for (const row of rows) {
    const bucket = buckets.get(row.day)
    if (!bucket) continue
    if (row.incoming) bucket.incoming += Number(row.n)
    else bucket.outgoing += Number(row.n) // agent + bot both count as outgoing
  }

  return keys.map((day) => ({ day, ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }) }))
}

// --- 3. Pipeline donut -------------------------------------------------

export async function loadPipelineDonut(accountId: string): Promise<PipelineDonutData> {
  const [stages, dealsRows] = await Promise.all([
    db
      .select({
        id: pipelineStages.id,
        name: pipelineStages.name,
        color: pipelineStages.color,
      })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
      .where(eq(pipelines.accountId, accountId))
      .orderBy(pipelineStages.position),
    db
      .select({ stage_id: deals.stageId, value: deals.value })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.status, 'open'))),
  ])

  const byStage = new Map<string, { count: number; total: number }>()
  for (const d of dealsRows) {
    const row = byStage.get(d.stage_id) ?? { count: 0, total: 0 }
    row.count += 1
    row.total += Number(d.value ?? 0)
    byStage.set(d.stage_id, row)
  }

  const slices: PipelineStageSlice[] = stages
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color || '#64748b',
      dealCount: byStage.get(s.id)?.count ?? 0,
      totalValue: byStage.get(s.id)?.total ?? 0,
    }))
    // Hide empty stages from the ring (but we'd still show them in the
    // legend if the user wanted a full breakdown — trimming keeps the
    // visual clean for the common case).
    .filter((s) => s.totalValue > 0 || s.dealCount > 0)

  return {
    stages: slices,
    totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
  }
}

// --- 4. Response time by day of week ----------------------------------

export async function loadResponseTime(accountId: string): Promise<ResponseTimeSummary> {
  // Pull the last 14 days of messages in one shot, then walk per
  // conversation to find each "first inbound" → "first subsequent
  // outbound" pair. 14 days gives us both "this week" + "last week"
  // with enough overlap if the user opens the dashboard late on a
  // Monday.
  const fourteenDaysAgo = daysAgoStart(13).toISOString()
  const rows = await db
    .select({
      conversation_id: messages.conversationId,
      sender_type: messages.senderType,
      created_at: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        gte(messages.createdAt, fourteenDaysAgo),
      ),
    )
    .orderBy(messages.conversationId, messages.createdAt)

  // Group per conversation, pair unreplied customer messages with the
  // next outbound message from the agent/bot. A single customer message
  // can only count once (avoids inflating averages if the customer
  // double-messages while the agent takes time to reply).
  interface Sample {
    customerAt: Date
    responseAt: Date
  }
  const samples: Sample[] = []

  let currentConv = ''
  let pendingCustomer: Date | null = null
  for (const row of rows) {
    if (row.conversation_id !== currentConv) {
      currentConv = row.conversation_id
      pendingCustomer = null
    }
    if (!row.created_at) continue
    const ts = new Date(row.created_at)
    if (row.sender_type === 'customer') {
      if (!pendingCustomer) pendingCustomer = ts
    } else if (pendingCustomer) {
      samples.push({ customerAt: pendingCustomer, responseAt: ts })
      pendingCustomer = null
    }
  }

  const now = new Date()
  const thisWeekStart = daysAgoStart(mondayIndex(now))
  const lastWeekStart = daysAgoStart(mondayIndex(now) + 7)

  // Per-day-of-week buckets, averaged over both weeks' worth of data
  // so each bar has more samples to stand on. If a day has no samples
  // its avgMinutes stays null and the chart renders the bar muted.
  const byDow = new Map<number, number[]>()
  for (let i = 0; i < 7; i++) byDow.set(i, [])
  const thisWeekMins: number[] = []
  const lastWeekMins: number[] = []

  for (const s of samples) {
    const diffMin = (s.responseAt.getTime() - s.customerAt.getTime()) / 60_000
    if (diffMin < 0) continue
    const dow = mondayIndex(s.customerAt)
    byDow.get(dow)!.push(diffMin)
    if (s.customerAt >= thisWeekStart) {
      thisWeekMins.push(diffMin)
    } else if (s.customerAt >= lastWeekStart && s.customerAt < thisWeekStart) {
      lastWeekMins.push(diffMin)
    }
  }

  const avg = (arr: number[]) =>
    arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length

  const buckets: ResponseTimeBucket[] = Array.from({ length: 7 }, (_, dow) => {
    const samples = byDow.get(dow) ?? []
    return {
      dow,
      avgMinutes: avg(samples),
      samples: samples.length,
    }
  })

  // Silence unused-label warnings — keep the arrays explicitly named
  // for readability above.
  void DOW_SHORT_MON_FIRST

  return {
    buckets,
    thisWeekAvg: avg(thisWeekMins),
    lastWeekAvg: avg(lastWeekMins),
  }
}

// --- 5. Activity feed --------------------------------------------------

export async function loadActivity(accountId: string, limit = 20): Promise<ActivityItem[]> {
  // Pull ~10 from each source (plenty of headroom after merge-sort),
  // then interleave by timestamp. The individual per-table limits
  // keep the payload small; the final limit is enforced after sort.
  const [msgs, contactRows, dealRows, broadcastRows, autoLogs] = await Promise.all([
    db
      .select({
        id: messages.id,
        created_at: messages.createdAt,
        conversation_id: messages.conversationId,
        contact_name: contacts.name,
        contact_phone: contacts.phone,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .leftJoin(contacts, eq(conversations.contactId, contacts.id))
      .where(
        and(
          eq(messages.accountId, accountId),
          eq(messages.senderType, 'customer'),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(10),
    db
      .select({
        id: contacts.id,
        name: contacts.name,
        phone: contacts.phone,
        created_at: contacts.createdAt,
      })
      .from(contacts)
      .where(eq(contacts.accountId, accountId))
      .orderBy(desc(contacts.createdAt))
      .limit(10),
    db
      .select({
        id: deals.id,
        title: deals.title,
        updated_at: deals.updatedAt,
        stage_name: pipelineStages.name,
      })
      .from(deals)
      .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .where(eq(deals.accountId, accountId))
      .orderBy(desc(deals.updatedAt))
      .limit(10),
    db
      .select({
        id: broadcasts.id,
        name: broadcasts.name,
        status: broadcasts.status,
        total_recipients: broadcasts.totalRecipients,
        created_at: broadcasts.createdAt,
      })
      .from(broadcasts)
      .where(eq(broadcasts.accountId, accountId))
      .orderBy(desc(broadcasts.createdAt))
      .limit(5),
    db
      .select({
        id: automationLogs.id,
        trigger_event: automationLogs.triggerEvent,
        status: automationLogs.status,
        created_at: automationLogs.createdAt,
        automation_name: automations.name,
        contact_name: contacts.name,
        contact_phone: contacts.phone,
      })
      .from(automationLogs)
      .innerJoin(automations, eq(automationLogs.automationId, automations.id))
      .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
      .where(eq(automationLogs.accountId, accountId))
      .orderBy(desc(automationLogs.createdAt))
      .limit(10),
  ])

  const items: ActivityItem[] = []

  for (const m of msgs) {
    const who = m.contact_name || m.contact_phone || 'Desconhecido'
    items.push({
      id: `msg-${m.id}`,
      kind: 'message',
      text: `Nova mensagem de ${who}`,
      at: m.created_at ?? '',
      href: `/inbox?c=${m.conversation_id}`,
    })
  }

  for (const c of contactRows) {
    items.push({
      id: `contact-${c.id}`,
      kind: 'contact',
      text: `Novo contato: ${c.name || c.phone}`,
      at: c.created_at ?? '',
      href: '/contacts',
    })
  }

  for (const d of dealRows) {
    items.push({
      id: `deal-${d.id}`,
      kind: 'deal',
      text: d.stage_name
        ? `Negócio "${d.title}" em ${d.stage_name}`
        : `Negócio "${d.title}" atualizado`,
      at: d.updated_at ?? '',
      href: '/pipelines',
    })
  }

  for (const b of broadcastRows) {
    const label =
      b.status === 'sent'
        ? `enviado para ${b.total_recipients ?? 0} contatos`
        : `${b.status} (${b.total_recipients ?? 0} destinatários)`
    items.push({
      id: `broadcast-${b.id}`,
      kind: 'broadcast',
      text: `Disparo "${b.name}" ${label}`,
      at: b.created_at ?? '',
      href: '/broadcasts',
    })
  }

  for (const l of autoLogs) {
    const who = l.contact_name || l.contact_phone || 'um contato'
    const autoName = l.automation_name || 'Automação'
    items.push({
      id: `auto-${l.id}`,
      kind: 'automation',
      text: `Automação "${autoName}" ${l.status === 'failed' ? 'falhou para' : 'acionada para'} ${who}`,
      at: l.created_at,
    })
  }

  return items
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0))
    .slice(0, limit)
}

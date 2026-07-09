// ============================================================
// Supervision queries — per-agent workload + SLA + response time.
//
// Read-only aggregates over conversations + messages, all account-scoped.
// The response-time walk mirrors src/lib/dashboard/queries.ts (pair each
// unanswered customer message with the next agent reply), extended to
// attribute samples to the replying agent and to expose the current
// "waiting" state (a conversation whose last message is from the customer).
// ============================================================

import { and, asc, eq, gte, inArray } from 'drizzle-orm';

import {
  db,
  conversations,
  messages,
  member,
  user,
  contacts,
  channels,
} from '@/db';
import type {
  AgentStat,
  SupervisionOverview,
  AgentConversationRow,
} from './types';

/** Walk 7 days of an account's messages once, returning per-conversation
 *  waiting state (the time of the oldest unanswered customer message, or
 *  null) and response-time samples grouped by the replying agent. */
async function walkAccountMessages(accountId: string): Promise<{
  pendingByConv: Map<string, number>; // convId → waiting-since (ms epoch)
  responseSumByAgent: Map<string, { sum: number; count: number }>;
}> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await db
    .select({
      conversationId: messages.conversationId,
      senderType: messages.senderType,
      senderId: messages.senderId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.accountId, accountId),
        gte(messages.createdAt, sevenDaysAgo),
      ),
    )
    .orderBy(messages.conversationId, messages.createdAt);

  const pendingByConv = new Map<string, number>();
  const responseSumByAgent = new Map<string, { sum: number; count: number }>();

  let currentConv = '';
  let pendingCustomer: number | null = null;
  const flush = (conv: string) => {
    if (conv && pendingCustomer != null) pendingByConv.set(conv, pendingCustomer);
  };

  for (const row of rows) {
    if (row.conversationId !== currentConv) {
      flush(currentConv);
      currentConv = row.conversationId;
      pendingCustomer = null;
    }
    if (!row.createdAt) continue;
    const ts = new Date(row.createdAt).getTime();
    if (row.senderType === 'customer') {
      if (pendingCustomer == null) pendingCustomer = ts;
    } else {
      // Agent/bot reply — close a pending sample and attribute it.
      if (pendingCustomer != null) {
        const diffMin = (ts - pendingCustomer) / 60_000;
        if (row.senderId && diffMin >= 0) {
          const acc = responseSumByAgent.get(row.senderId) ?? { sum: 0, count: 0 };
          acc.sum += diffMin;
          acc.count += 1;
          responseSumByAgent.set(row.senderId, acc);
        }
        pendingCustomer = null;
      }
    }
  }
  flush(currentConv);

  return { pendingByConv, responseSumByAgent };
}

/** Per-agent workload overview for the supervision panel (admins). */
export async function loadSupervision(
  accountId: string,
): Promise<SupervisionOverview> {
  const now = Date.now();

  const members = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, accountId))
    .orderBy(asc(user.name));

  const openConvs = await db
    .select({
      id: conversations.id,
      assignedAgentId: conversations.assignedAgentId,
    })
    .from(conversations)
    .where(
      and(eq(conversations.accountId, accountId), eq(conversations.status, 'open')),
    );

  const { pendingByConv, responseSumByAgent } = await walkAccountMessages(accountId);

  // Aggregate per agent.
  const stat = new Map<string, { open: number; waiting: number; maxWaitMin: number }>();
  let unassignedOpen = 0;
  let totalWaiting = 0;
  for (const c of openConvs) {
    const waitingSince = pendingByConv.get(c.id) ?? null;
    const isWaiting = waitingSince != null;
    if (isWaiting) totalWaiting += 1;
    if (!c.assignedAgentId) {
      unassignedOpen += 1;
      continue;
    }
    const s = stat.get(c.assignedAgentId) ?? { open: 0, waiting: 0, maxWaitMin: 0 };
    s.open += 1;
    if (isWaiting) {
      s.waiting += 1;
      const mins = Math.floor((now - waitingSince!) / 60_000);
      if (mins > s.maxWaitMin) s.maxWaitMin = mins;
    }
    stat.set(c.assignedAgentId, s);
  }

  const agents: AgentStat[] = members.map((m) => {
    const s = stat.get(m.id);
    const resp = responseSumByAgent.get(m.id);
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      image: m.image,
      open: s?.open ?? 0,
      waiting: s?.waiting ?? 0,
      maxWaitingMin: s && s.waiting > 0 ? s.maxWaitMin : null,
      avgResponseMin:
        resp && resp.count > 0 ? Math.round(resp.sum / resp.count) : null,
    };
  });

  return {
    agents,
    totalOpen: openConvs.length,
    totalWaiting,
    unassignedOpen,
  };
}

/** The open conversations assigned to one agent, with waiting time. */
export async function loadAgentConversations(
  accountId: string,
  agentId: string,
): Promise<AgentConversationRow[]> {
  const now = Date.now();
  const rows = await db
    .select({
      id: conversations.id,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      unread: conversations.unreadCount,
      contactName: contacts.name,
      channelName: channels.name,
    })
    .from(conversations)
    .leftJoin(contacts, eq(conversations.contactId, contacts.id))
    .leftJoin(channels, eq(conversations.channelId, channels.id))
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.assignedAgentId, agentId),
        eq(conversations.status, 'open'),
      ),
    )
    .orderBy(asc(conversations.lastMessageAt));

  const { pendingByConv } = await walkAccountMessages(accountId);

  return rows.map((r) => {
    const waitingSince = pendingByConv.get(r.id) ?? null;
    return {
      id: r.id,
      contactName: r.contactName ?? 'Sem nome',
      channelName: r.channelName,
      status: r.status,
      lastMessageAt: r.lastMessageAt,
      waitingMin:
        waitingSince != null ? Math.floor((now - waitingSince) / 60_000) : null,
      unread: r.unread ?? 0,
    };
  });
}

// ============================================================
// SLA auto-reassign — moves an assigned conversation to another agent when
// it has waited too long for a reply. Runs from the worker on a 1-minute
// tick. Reassigning updates conversations.assigned_agent_id, which fires the
// `notify_conversation_assigned` DB trigger → the new agent is notified.
//
// Anti–ping-pong: the SLA clock starts at max(oldest-unanswered-customer-msg,
// assigned_at), so a just-reassigned conversation gives the new agent the
// full window before it can be reassigned again.
// ============================================================

import { and, eq, isNotNull } from 'drizzle-orm';

import { db, conversations, member, accountSettings } from '@/db';
import type { AccountSettings } from '@/lib/settings/account-settings';
import { walkAccountMessages } from './queries';

/** Roles that actually handle conversations (viewers are read-only). */
const HANDLING_ROLES = new Set(['owner', 'admin', 'agent']);

export async function runSlaReassignForAccount(
  accountId: string,
  minutes: number,
): Promise<number> {
  const now = Date.now();
  const windowMs = Math.max(1, minutes) * 60_000;

  const { pendingByConv } = await walkAccountMessages(accountId);

  const convs = await db
    .select({
      id: conversations.id,
      assignedAgentId: conversations.assignedAgentId,
      assignedAt: conversations.assignedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.status, 'open'),
        isNotNull(conversations.assignedAgentId),
      ),
    );

  // Eligible targets = handling-role members; track current open load.
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  const eligible = members
    .filter((m) => HANDLING_ROLES.has(m.role))
    .map((m) => m.userId);
  if (eligible.length < 2) return 0; // no one else to hand off to

  const loadByAgent = new Map<string, number>();
  for (const c of convs) {
    if (c.assignedAgentId) {
      loadByAgent.set(c.assignedAgentId, (loadByAgent.get(c.assignedAgentId) ?? 0) + 1);
    }
  }

  let reassigned = 0;
  for (const c of convs) {
    if (!c.assignedAgentId) continue;
    const pending = pendingByConv.get(c.id);
    if (pending == null) continue; // not awaiting a reply
    const assignedAtMs = c.assignedAt ? new Date(c.assignedAt).getTime() : 0;
    const clockStart = Math.max(pending, assignedAtMs);
    if (now - clockStart < windowMs) continue; // still within the window

    const candidates = eligible
      .filter((id) => id !== c.assignedAgentId)
      .sort((a, b) => (loadByAgent.get(a) ?? 0) - (loadByAgent.get(b) ?? 0));
    if (candidates.length === 0) continue;
    const target = candidates[0];

    try {
      await db
        .update(conversations)
        .set({ assignedAgentId: target, assignedAt: new Date().toISOString() })
        .where(eq(conversations.id, c.id));
      loadByAgent.set(c.assignedAgentId, (loadByAgent.get(c.assignedAgentId) ?? 1) - 1);
      loadByAgent.set(target, (loadByAgent.get(target) ?? 0) + 1);
      reassigned += 1;
      console.log(
        `[sla] reassigned conversation ${c.id} (${accountId}) ${c.assignedAgentId} → ${target}`,
      );
    } catch (err) {
      console.error('[sla] reassign failed:', err);
    }
  }
  return reassigned;
}

/** Scan every account that has auto-reassign enabled and run its SLA. */
export async function runSlaReassignAll(): Promise<void> {
  const rows = await db
    .select({
      accountId: accountSettings.accountId,
      settings: accountSettings.settings,
    })
    .from(accountSettings);

  for (const r of rows) {
    const s = (r.settings ?? {}) as Partial<AccountSettings>;
    if (!s.autoReassignEnabled) continue;
    const minutes =
      typeof s.autoReassignMinutes === 'number' && s.autoReassignMinutes > 0
        ? s.autoReassignMinutes
        : 5;
    try {
      await runSlaReassignForAccount(r.accountId, minutes);
    } catch (err) {
      console.error(`[sla] account ${r.accountId} failed:`, err);
    }
  }
}

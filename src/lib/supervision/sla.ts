// ============================================================
// SLA auto-reassign (Phase 3) — sector-aware, "só sem 1ª resposta".
//
// Runs from the worker on a 1-minute tick over open, assigned conversations
// that have waited past the account's SLA window. Two paths:
//
//   • Never replied yet (no human-agent message): REASSIGN to another handling
//     member OF THE SAME SECTOR (least-loaded). A null-sector (general-queue)
//     conversation falls back to any handling member. Writing
//     assigned_agent_id fires the `notify_conversation_assigned` trigger.
//
//   • Already engaged (the agent replied at least once) or nobody to hand off
//     to: DON'T reassign — raise an `sla_alert` notification to the account's
//     admins/owner instead (deduped so it fires once per breach, not per tick).
//
// Anti–ping-pong: the SLA clock starts at max(oldest-unanswered-customer-msg,
// assigned_at), so a just-reassigned conversation gives the new agent the
// full window before it can be reassigned again.
// ============================================================

import { and, eq, gte, inArray, isNotNull } from 'drizzle-orm';

import {
  db,
  conversations,
  member,
  accountSettings,
  sectorMembers,
  notifications,
  contacts,
} from '@/db';
import type { AccountSettings } from '@/lib/settings/account-settings';
import { publishEvent } from '@/lib/events/publish';
import { walkAccountMessages } from './queries';

/** Roles that actually handle conversations (viewers are read-only). */
const HANDLING_ROLES = new Set(['owner', 'admin', 'agent']);

export async function runSlaReassignForAccount(
  accountId: string,
  minutes: number,
): Promise<number> {
  const now = Date.now();
  const windowMs = Math.max(1, minutes) * 60_000;

  const { pendingByConv, agentRepliedConvs } = await walkAccountMessages(accountId);

  const convs = await db
    .select({
      id: conversations.id,
      assignedAgentId: conversations.assignedAgentId,
      assignedAt: conversations.assignedAt,
      sectorId: conversations.sectorId,
      contactId: conversations.contactId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.accountId, accountId),
        eq(conversations.status, 'open'),
        isNotNull(conversations.assignedAgentId),
      ),
    );

  // Handling-role members of the account, and the current open load per agent.
  const members = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  const handling = new Set(
    members.filter((m) => HANDLING_ROLES.has(m.role)).map((m) => m.userId),
  );
  const adminUserIds = members
    .filter((m) => m.role === 'owner' || m.role === 'admin')
    .map((m) => m.userId);

  const loadByAgent = new Map<string, number>();
  for (const c of convs) {
    if (c.assignedAgentId) {
      loadByAgent.set(c.assignedAgentId, (loadByAgent.get(c.assignedAgentId) ?? 0) + 1);
    }
  }

  // Sector → handling-member ids (built lazily, cached per run).
  const sectorPoolCache = new Map<string, string[]>();
  const sectorPool = async (sectorId: string): Promise<string[]> => {
    const cached = sectorPoolCache.get(sectorId);
    if (cached) return cached;
    const rows = await db
      .select({ userId: sectorMembers.userId })
      .from(sectorMembers)
      .where(eq(sectorMembers.sectorId, sectorId));
    const pool = rows.map((r) => r.userId).filter((id) => handling.has(id));
    sectorPoolCache.set(sectorId, pool);
    return pool;
  };
  // Global handling pool for null-sector (general queue) conversations.
  const globalPool = [...handling];

  let reassigned = 0;
  for (const c of convs) {
    if (!c.assignedAgentId) continue;
    const pending = pendingByConv.get(c.id);
    if (pending == null) continue; // not awaiting a reply
    const assignedAtMs = c.assignedAt ? new Date(c.assignedAt).getTime() : 0;
    const clockStart = Math.max(pending, assignedAtMs);
    if (now - clockStart < windowMs) continue; // still within the window

    // Already engaged (a human agent replied at least once) → alert only.
    if (agentRepliedConvs.has(c.id)) {
      await raiseSlaAlert(accountId, c.id, c.contactId, adminUserIds, windowMs);
      continue;
    }

    // Never replied → reassign within the same sector (or global if none).
    const pool = c.sectorId ? await sectorPool(c.sectorId) : globalPool;
    const candidates = pool
      .filter((id) => id !== c.assignedAgentId)
      .sort((a, b) => (loadByAgent.get(a) ?? 0) - (loadByAgent.get(b) ?? 0));
    if (candidates.length === 0) {
      // No one else in the sector to hand off to — alert instead of dropping it.
      await raiseSlaAlert(accountId, c.id, c.contactId, adminUserIds, windowMs);
      continue;
    }
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

/**
 * Raise an `sla_alert` notification to the account's admins/owner for an
 * engaged conversation that breached SLA. Deduped: skips when any admin
 * already has an sla_alert for this conversation newer than one SLA window
 * ago, so it fires roughly once per breach rather than every tick.
 */
async function raiseSlaAlert(
  accountId: string,
  conversationId: string,
  contactId: string | null,
  adminUserIds: string[],
  windowMs: number,
): Promise<void> {
  if (adminUserIds.length === 0) return;
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const recent = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, accountId),
          eq(notifications.conversationId, conversationId),
          eq(notifications.type, 'sla_alert'),
          inArray(notifications.userId, adminUserIds),
          gte(notifications.createdAt, since),
        ),
      )
      .limit(1);
    if (recent.length > 0) return; // already alerted this breach

    let contactName = 'um cliente';
    if (contactId) {
      const [c] = await db
        .select({ name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, contactId))
        .limit(1);
      if (c?.name) contactName = c.name;
    }

    await db.insert(notifications).values(
      adminUserIds.map((userId) => ({
        accountId,
        userId,
        type: 'sla_alert' as const,
        conversationId,
        contactId: contactId ?? null,
        title: 'Atendimento demorando',
        body: `A conversa com ${contactName} passou do tempo de resposta e o atendente já respondeu antes — dá uma olhada.`,
      })),
    );
    await publishEvent(accountId, { type: 'notification' });
  } catch (err) {
    console.error('[sla] raiseSlaAlert failed:', err);
  }
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

// ============================================================
// Sector-based conversation visibility (privacy). TWO tiers (owner's spec):
//
//   • LIST (conversationVisibility): what shows in the inbox list.
//       - agent/viewer: every NON-private conversation in their sectors (ANY
//         assignee — so they see the sector's volume + who's handling what),
//         plus their own, plus @mentions, plus the open general queue. NEVER a
//         conversation assigned to an admin/owner.
//       - supervisor: everything EXCEPT admin/owner-assigned.
//       - admin/owner: everything.
//   • READ (canReadConversation): whether the caller may OPEN the thread /
//     act on it. Sector model (Felipe's spec): inside a sector the agent
//     belongs to, teammates READ and reply to each other's threads even when
//     assigned to someone else — assignment just marks "who picked it up
//     first", it no longer locks the sector out. The private lock (isPrivate)
//     is what hides a thread: a private thread is readable only by its owner +
//     admin + supervisor. On a NO-sector (open/general) channel, an unassigned
//     thread is readable by all agents, but once taken it becomes the owner's
//     (only they + admin/supervisor read it).
//
// "Ninguém vê as do admin" is absolute at BOTH tiers: an admin/owner-assigned
// conversation is never listed nor readable by a non-admin — not even via an
// @mention or a shared sector. Because an admin's own thread is assigned to the
// admin, its private lock is also honored against the SUPERVISOR (admin-
// assigned → supervisor can't read). `accountId` scopes the admin/owner lookup.
// ============================================================

import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
  isNotNull,
} from 'drizzle-orm';

import {
  db,
  member,
  sectorMembers,
  conversations,
  conversationParticipants,
  channels,
} from '@/db';
import { firstOrNull } from '@/db/helpers';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/** Sector ids a user belongs to. */
export async function getUserSectorIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ sectorId: sectorMembers.sectorId })
    .from(sectorMembers)
    .where(eq(sectorMembers.userId, userId));
  return rows.map((r) => r.sectorId);
}

/** User ids that are admin/owner in the account. Their conversations are never
 *  visible to a non-admin (list or read). */
export async function getAdminUserIds(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, accountId),
        inArray(member.role, ['admin', 'owner']),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Whether a specific user is an admin/owner of the account. */
export async function isAdminUser(
  accountId: string,
  userId: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, accountId),
          eq(member.userId, userId),
          inArray(member.role, ['admin', 'owner']),
        ),
      )
      .limit(1),
  );
  return !!row;
}

/** Conversation ids the user is an explicit participant of (@mentioned). */
export async function getParticipantConversationIds(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ conversationId: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .where(eq(conversationParticipants.userId, userId));
  return rows.map((r) => r.conversationId);
}

/**
 * LIST tier — a WHERE condition restricting `conversations` to what the caller
 * may see in the inbox list, or `undefined` for admins/owner (no restriction).
 */
/**
 * 📌 Canais DEDICADOS da conta: channel_id → user_id do dono exclusivo.
 * As conversas desses canais só aparecem pro dono (admin/owner e supervisor
 * veem tudo). Pra mais de uma pessoa por canal existe o setor.
 */
export async function getDedicatedChannelMap(
  accountId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: channels.id, userId: channels.dedicatedUserId })
    .from(channels)
    .where(and(eq(channels.accountId, accountId), isNotNull(channels.dedicatedUserId)));
  const map = new Map<string, string>();
  for (const r of rows) if (r.userId) map.set(r.id, r.userId);
  return map;
}

/** Dono exclusivo do canal desta conversa (null = canal comum). */
async function dedicatedOwnerOfConversation(conversationId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ userId: channels.dedicatedUserId })
      .from(conversations)
      .innerJoin(channels, eq(conversations.channelId, channels.id))
      .where(eq(conversations.id, conversationId))
      .limit(1),
  );
  return row?.userId ?? null;
}

export async function conversationVisibility(
  role: AccountRole,
  userId: string,
  accountId: string,
): Promise<SQL | undefined> {
  // Admin/owner see everything.
  if (hasMinRole(role, 'admin')) return undefined;

  // Supervisor: everything EXCEPT conversations assigned to an admin/owner.
  if (hasMinRole(role, 'supervisor')) {
    const adminIds = await getAdminUserIds(accountId);
    if (adminIds.length === 0) return undefined;
    return or(
      isNull(conversations.assignedAgentId),
      notInArray(conversations.assignedAgentId, adminIds),
    );
  }

  // Agent/viewer LIST: their own, @mentions, the open general queue, and every
  // non-private conversation in their sectors (any assignee).
  const sectorIds = await getUserSectorIds(userId);
  const mine = eq(conversations.assignedAgentId, userId);
  const participant = sql`${conversations.id} IN (SELECT conversation_id FROM conversation_participants WHERE user_id = ${userId})`;
  const openQueue = and(
    isNull(conversations.sectorId),
    isNull(conversations.assignedAgentId),
  ) as SQL;
  const sectorScope =
    sectorIds.length === 0
      ? openQueue
      : (or(inArray(conversations.sectorId, sectorIds), openQueue) as SQL);
  // Private threads in the caller's sector are still LISTED (shown as a locked
  // row so the team knows one's being handled), just not readable — Felipe's
  // tweak. A private thread has no sector match only when it's outside the
  // caller's sectors, and openQueue never matches a private (always assigned),
  // so a no-sector private stays hidden. read_blocked masks the preview.
  // 📌 Canal dedicado: o dono vê TODAS as conversas do canal dele; ninguém
  // mais (abaixo de supervisor) vê conversa de canal dedicado a outra pessoa.
  // ⚠️ Subquery raw: a coluna externa vai como literal "conversations"."channel_id"
  // (ver memória drizzle-subquery-unqualified).
  const mineDedicated = sql`"conversations"."channel_id" IN (SELECT id FROM channels WHERE account_id = ${accountId} AND dedicated_user_id = ${userId})`;
  const notOthersDedicated = sql`("conversations"."channel_id" IS NULL OR "conversations"."channel_id" NOT IN (SELECT id FROM channels WHERE account_id = ${accountId} AND dedicated_user_id IS NOT NULL AND dedicated_user_id <> ${userId}))`;
  const base = and(
    notOthersDedicated,
    or(mine, participant, sectorScope, mineDedicated),
  ) as SQL;
  // "Ninguém vê as do admin": exclude admin/owner-assigned entirely.
  const adminIds = await getAdminUserIds(accountId);
  if (adminIds.length === 0) return base;
  const notAdminAssigned = or(
    isNull(conversations.assignedAgentId),
    notInArray(conversations.assignedAgentId, adminIds),
  ) as SQL;
  return and(notAdminAssigned, base);
}

/**
 * READ tier — whether the caller may OPEN / act on a specific conversation.
 * Strict: an agent reads only their own, @mentions, and unassigned queue items;
 * a teammate's assigned thread is not readable (blocked notice in the UI).
 */
export async function canReadConversation(
  role: AccountRole,
  userId: string,
  accountId: string,
  conversationSectorId: string | null,
  assignedAgentId: string | null = null,
  conversationId?: string,
  isPrivate = false,
): Promise<boolean> {
  // Admin/owner read all.
  if (hasMinRole(role, 'admin')) return true;
  // The assignee always reads their own thread.
  if (assignedAgentId && assignedAgentId === userId) return true;
  // Supervisor: everything except an admin/owner-assigned thread.
  if (hasMinRole(role, 'supervisor')) {
    if (assignedAgentId && (await isAdminUser(accountId, assignedAgentId))) {
      return false;
    }
    return true;
  }
  // "Ninguém vê as do admin" — before the @mention exception.
  if (assignedAgentId && (await isAdminUser(accountId, assignedAgentId))) {
    return false;
  }
  // 📌 Canal dedicado: abaixo de supervisor, só o dono do canal abre.
  if (conversationId) {
    const dedicated = await dedicatedOwnerOfConversation(conversationId);
    if (dedicated) return dedicated === userId;
  }
  // @mention participant — reads this one thread regardless of owner/sector.
  if (conversationId && (await isParticipant(conversationId, userId))) {
    return true;
  }
  if (isPrivate) return false;
  // Sector team (Felipe's spec): inside a sector the caller belongs to, agents
  // READ (and reply to) each other's threads even when assigned to a teammate.
  // Assignment now just marks "who picked it up first" — it no longer locks the
  // sector out; only the private lock (isPrivate, above) does. (Admin-assigned
  // already returned false above.)
  if (conversationSectorId) {
    const sectorIds = await getUserSectorIds(userId);
    return sectorIds.includes(conversationSectorId);
  }
  // No sector (open/general queue): an UNASSIGNED thread is readable by everyone;
  // once an agent takes it, it becomes the owner's (only they + admin/supervisor
  // read it), so a non-owner agent can't open an assigned no-sector thread.
  return !assignedAgentId;
}

/**
 * LIST tier for a SINGLE conversation — mirrors `conversationVisibility`. Lets
 * the deep-link loader tell "blocked" (listed but not readable → show notice)
 * apart from "hidden" (not listed → 404/null).
 */
export async function canListConversation(
  role: AccountRole,
  userId: string,
  accountId: string,
  conversationSectorId: string | null,
  assignedAgentId: string | null = null,
  conversationId?: string,
  isPrivate = false,
): Promise<boolean> {
  if (hasMinRole(role, 'admin')) return true;
  // Admin/owner conversations are never listed to a non-admin.
  if (assignedAgentId && (await isAdminUser(accountId, assignedAgentId))) {
    return false;
  }
  if (hasMinRole(role, 'supervisor')) return true;
  if (assignedAgentId && assignedAgentId === userId) return true;
  // 📌 Canal dedicado: só o dono lista.
  if (conversationId) {
    const dedicated = await dedicatedOwnerOfConversation(conversationId);
    if (dedicated) return dedicated === userId;
  }
  if (conversationId && (await isParticipant(conversationId, userId))) {
    return true;
  }
  // Sector member: sees every conversation in their sectors (any assignee) —
  // INCLUDING private ones, which show as a locked row (read is still blocked
  // by canReadConversation). Felipe's tweak: a private thread must appear
  // locked, not vanish.
  if (conversationSectorId) {
    const sectorIds = await getUserSectorIds(userId);
    return sectorIds.includes(conversationSectorId);
  }
  // No sector: a private or assigned thread is hidden — only the open
  // (unassigned) queue is listed.
  if (isPrivate) return false;
  return !assignedAgentId;
}

/**
 * Pure READ check for a list row already fetched, using pre-loaded sets (no
 * per-row queries). Must mirror `canReadConversation` for an agent/viewer.
 */
export function agentCanReadRow(args: {
  userId: string;
  conversationId: string;
  sectorId: string | null;
  assignedAgentId: string | null;
  isPrivate: boolean;
  sectorIds: Set<string>;
  adminIds: Set<string>;
  participantIds: Set<string>;
  /** 📌 Canal da conversa + mapa canal→dono (canais dedicados). Opcionais. */
  channelId?: string | null;
  dedicatedByChannel?: Map<string, string>;
}): boolean {
  const {
    userId,
    conversationId,
    sectorId,
    assignedAgentId,
    isPrivate,
    sectorIds,
    adminIds,
    participantIds,
    channelId,
    dedicatedByChannel,
  } = args;
  if (assignedAgentId && assignedAgentId === userId) return true;
  if (assignedAgentId && adminIds.has(assignedAgentId)) return false;
  // 📌 Canal dedicado: só o dono lê as conversas dele.
  if (channelId && dedicatedByChannel?.has(channelId)) {
    return dedicatedByChannel.get(channelId) === userId;
  }
  if (participantIds.has(conversationId)) return true;
  if (isPrivate) return false;
  // Sector-mate reads teammates' threads (assigned or not); a no-sector thread
  // is readable only while unassigned (open queue), then becomes the owner's.
  if (sectorId) return sectorIds.has(sectorId);
  return !assignedAgentId;
}

/** True when the user is an explicit participant of the conversation. */
export async function isParticipant(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: conversationParticipants.id })
      .from(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .limit(1),
  );
  return !!row;
}

// Re-export for callers that need the raw helpers.
export { and, sql };

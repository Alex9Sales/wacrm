// ============================================================
// Sector-based conversation visibility (privacy).
//
// The model (per owner's spec):
//   • agent/viewer: sees a conversation ONLY when it's assigned to THEM, they
//     were @mentioned into it, or it's an UNASSIGNED queue item they could pick
//     up (open general queue, or unassigned in one of their sectors). An
//     ASSIGNED conversation is private to its assignee — teammates in the same
//     sector no longer see each other's assigned threads.
//   • supervisor: sees everything EXCEPT conversations assigned to an
//     admin/owner ("ninguém vê as do admin").
//   • admin/owner: sees everything.
// This module builds the reusable WHERE condition and the single-conversation
// access check. `accountId` scopes the admin/owner lookup.
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
} from 'drizzle-orm';

import {
  db,
  member,
  sectorMembers,
  conversations,
  conversationParticipants,
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

/** User ids that are admin/owner in the account. Their assigned conversations
 *  are visible only to other admins/owners — supervisors and agents never see
 *  them. */
async function getAdminUserIds(accountId: string): Promise<string[]> {
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

/** Unassigned queue an agent may pick up: no assignee AND (no sector, or one of
 *  the agent's sectors). */
function unassignedQueue(sectorIds: string[]): SQL {
  const inScope =
    sectorIds.length === 0
      ? isNull(conversations.sectorId)
      : (or(
          isNull(conversations.sectorId),
          inArray(conversations.sectorId, sectorIds),
        ) as SQL);
  return and(isNull(conversations.assignedAgentId), inScope) as SQL;
}

/**
 * A WHERE condition restricting `conversations` to what the caller may see,
 * or `undefined` for admins/owner (no restriction). Callers `and()` it with
 * their account scope.
 */
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

  // Agent/viewer: only their own, @mentions, or an unassigned queue item.
  const sectorIds = await getUserSectorIds(userId);
  const mine = eq(conversations.assignedAgentId, userId);
  // Conversations you were @mentioned into (a participant) — otherwise a
  // mention is a dead link.
  const participant = sql`${conversations.id} IN (SELECT conversation_id FROM conversation_participants WHERE user_id = ${userId})`;
  const notPrivate = eq(conversations.isPrivate, false);
  const base = or(
    mine,
    participant,
    and(notPrivate, unassignedQueue(sectorIds)) as SQL,
  ) as SQL;
  // "Ninguém vê as do admin": a conversation assigned to an admin/owner is
  // never visible to an agent — not even one they were @mentioned into.
  const adminIds = await getAdminUserIds(accountId);
  if (adminIds.length === 0) return base;
  const notAdminAssigned = or(
    isNull(conversations.assignedAgentId),
    notInArray(conversations.assignedAgentId, adminIds),
  ) as SQL;
  return and(notAdminAssigned, base);
}

/** Whether the caller may open a specific conversation. Pass `conversationId`
 *  so an @mention participant is granted access even to a private thread. */
export async function canSeeConversation(
  role: AccountRole,
  userId: string,
  accountId: string,
  conversationSectorId: string | null,
  assignedAgentId: string | null = null,
  conversationId?: string,
  isPrivate = false,
): Promise<boolean> {
  // Admin/owner see all.
  if (hasMinRole(role, 'admin')) return true;

  // The assignee always sees their own thread.
  if (assignedAgentId && assignedAgentId === userId) return true;

  // Supervisor: everything except a conversation assigned to an admin/owner.
  if (hasMinRole(role, 'supervisor')) {
    if (assignedAgentId && (await isAdminUser(accountId, assignedAgentId))) {
      return false;
    }
    return true;
  }

  // "Ninguém vê as do admin": a conversation assigned to an admin/owner is
  // never visible to an agent — checked before the @mention exception so a
  // stray mention can't expose it.
  if (assignedAgentId && (await isAdminUser(accountId, assignedAgentId))) {
    return false;
  }
  // @mention participant — access to this one conversation regardless of
  // owner/sector/private.
  if (conversationId && (await isParticipant(conversationId, userId))) {
    return true;
  }
  // Private beyond this point is not visible to anyone else.
  if (isPrivate) return false;
  // Assigned to someone else — private to that assignee now.
  if (assignedAgentId) return false;
  // Unassigned: open general queue is visible to all; a sector queue only to
  // that sector's members.
  if (!conversationSectorId) return true;
  const sectorIds = await getUserSectorIds(userId);
  return sectorIds.includes(conversationSectorId);
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

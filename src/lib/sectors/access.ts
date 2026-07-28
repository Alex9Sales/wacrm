// ============================================================
// Sector-based conversation visibility (privacy).
//
// A non-admin agent sees a conversation when ANY of:
//   • it's assigned to them, OR
//   • its sector is one they belong to, OR
//   • it's in the OPEN general queue (no sector AND no assignee).
// So a no-sector conversation assigned to another agent stays private.
// Admins/owner see everything. This module builds the reusable WHERE
// condition and the single-conversation access check.
// ============================================================

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
// NOTE: `is_private` conversations (migration 0032) are visible only to the
// assigned agent, explicit @mention participants, and supervisor+ ("see all").

import { db, sectorMembers, conversations, conversationParticipants } from '@/db';
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

/** The open-queue condition: no sector AND nobody assigned yet. */
function openQueue(): SQL {
  return and(
    isNull(conversations.sectorId),
    isNull(conversations.assignedAgentId),
  ) as SQL;
}

/**
 * A WHERE condition restricting `conversations` to what the caller may see,
 * or `undefined` for admins/owner (no restriction). Callers `and()` it with
 * their account scope.
 */
export async function conversationVisibility(
  role: AccountRole,
  userId: string,
): Promise<SQL | undefined> {
  // Supervisor+ (canSeeAllConversations) see everything, including private.
  if (hasMinRole(role, 'supervisor')) return undefined;
  const sectorIds = await getUserSectorIds(userId);
  const mine = eq(conversations.assignedAgentId, userId);
  // Conversations you were @mentioned into (a participant), regardless of
  // sector/assignee/private — otherwise a mention is a dead link.
  const participant = sql`${conversations.id} IN (SELECT conversation_id FROM conversation_participants WHERE user_id = ${userId})`;
  // Sector / open-queue visibility only applies to non-private conversations.
  const notPrivate = eq(conversations.isPrivate, false);
  const sectorVis =
    sectorIds.length === 0
      ? openQueue()
      : (or(inArray(conversations.sectorId, sectorIds), openQueue()) as SQL);
  return or(mine, participant, and(notPrivate, sectorVis) as SQL);
}

/** Whether the caller may open a specific conversation. Pass `conversationId`
 *  so an @mention participant is granted access even to a private thread. */
export async function canSeeConversation(
  role: AccountRole,
  userId: string,
  conversationSectorId: string | null,
  assignedAgentId: string | null = null,
  conversationId?: string,
  isPrivate = false,
): Promise<boolean> {
  // Supervisor+ see all; the assignee always sees their own thread.
  if (hasMinRole(role, 'supervisor')) return true;
  if (assignedAgentId && assignedAgentId === userId) return true;
  // @mention participant — access to this one conversation regardless of
  // owner/sector/private.
  if (conversationId && (await isParticipant(conversationId, userId))) {
    return true;
  }
  // Private beyond this point is not visible to anyone else.
  if (isPrivate) return false;
  // Open general queue — no sector and no owner yet.
  if (!conversationSectorId && !assignedAgentId) return true;
  if (!conversationSectorId) return false; // no sector but owned by someone else
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

// ============================================================
// Sector-based conversation visibility (privacy).
//
// A non-admin agent sees a conversation only when it has NO sector (the
// general queue, open to everyone) or its sector is one they belong to.
// Admins/owner see everything. This module builds the reusable WHERE
// condition and the single-conversation access check.
// ============================================================

import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { db, sectorMembers, conversations } from '@/db';
import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/** Sector ids a user belongs to. */
export async function getUserSectorIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ sectorId: sectorMembers.sectorId })
    .from(sectorMembers)
    .where(eq(sectorMembers.userId, userId));
  return rows.map((r) => r.sectorId);
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
  if (hasMinRole(role, 'admin')) return undefined;
  const sectorIds = await getUserSectorIds(userId);
  if (sectorIds.length === 0) return isNull(conversations.sectorId);
  return or(
    isNull(conversations.sectorId),
    inArray(conversations.sectorId, sectorIds),
  );
}

/** Whether the caller may open a specific conversation (its sector). */
export async function canSeeConversation(
  role: AccountRole,
  userId: string,
  conversationSectorId: string | null,
): Promise<boolean> {
  if (hasMinRole(role, 'admin')) return true;
  if (!conversationSectorId) return true; // general queue
  const sectorIds = await getUserSectorIds(userId);
  return sectorIds.includes(conversationSectorId);
}

// Re-export for callers that need the raw helpers.
export { and, sql };

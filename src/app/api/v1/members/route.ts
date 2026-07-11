// ============================================================
// GET /api/v1/members — list the account's team members
//   (scope: members:read). Returns ids + names so a caller (e.g. Hermes)
//   can resolve who to assign a conversation to, or who sends an internal
//   message. Read-only — member creation is intentionally NOT exposed.
// ============================================================

import { asc, eq } from 'drizzle-orm';

import { db, member, user } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'members:read');
    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: member.role,
      })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(eq(member.organizationId, ctx.accountId))
      .orderBy(asc(user.name));
    return ok({ data: rows });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

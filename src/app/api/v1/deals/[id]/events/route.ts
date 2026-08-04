// ============================================================
// GET /api/v1/deals/{id}/events — the deal's history/timeline. scope: deals:read
//
// Returns the deal's events newest-first (created, stage_changed,
// status_changed, transferred, note). Read-only; the account owns the deal.
// ============================================================

import { and, desc, eq } from 'drizzle-orm';

import { db, deals, dealEvents } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await params;

    const owned = firstOrNull(
      await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    );
    if (!owned) return fail('not_found', 'Deal not found', 404);

    const rows = await db
      .select({
        id: dealEvents.id,
        type: dealEvents.type,
        data: dealEvents.data,
        actor_user_id: dealEvents.actorUserId,
        created_at: dealEvents.createdAt,
      })
      .from(dealEvents)
      .where(and(eq(dealEvents.dealId, id), eq(dealEvents.accountId, ctx.accountId)))
      .orderBy(desc(dealEvents.createdAt))
      .limit(200);

    return ok(rows);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ============================================================
// GET /api/v1/broadcasts/{id} — broadcast status + counts
// (scope: broadcasts:send).
//
// Poll this after POST /api/v1/broadcasts to watch the fan-out
// progress. `status` moves 'sending' → 'sent'; the delivered/read
// counts continue to climb as Meta delivery webhooks arrive.
// Account-scoped: a foreign id → 404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, broadcasts } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;

    let data;
    try {
      data = firstOrNull(
        await db
          .select({
            id: broadcasts.id,
            name: broadcasts.name,
            template_name: broadcasts.templateName,
            template_language: broadcasts.templateLanguage,
            status: broadcasts.status,
            total_recipients: broadcasts.totalRecipients,
            sent_count: broadcasts.sentCount,
            delivered_count: broadcasts.deliveredCount,
            read_count: broadcasts.readCount,
            replied_count: broadcasts.repliedCount,
            failed_count: broadcasts.failedCount,
            created_at: broadcasts.createdAt,
            updated_at: broadcasts.updatedAt,
          })
          .from(broadcasts)
          .where(
            and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId))
          )
          .limit(1)
      );
    } catch (error) {
      console.error('[api/v1/broadcasts] read error:', error);
      return fail('internal', 'Failed to read broadcast', 500);
    }

    if (!data) return fail('not_found', 'Broadcast not found', 404);

    return ok(data);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

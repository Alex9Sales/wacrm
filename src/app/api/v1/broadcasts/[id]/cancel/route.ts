// ============================================================
// POST /api/v1/broadcasts/{id}/cancel — cancel a broadcast
// (scope: broadcasts:send). Terminal: pending recipients won't send
// (their queued jobs see 'cancelled' and skip). Blocked once already
// sent/failed/cancelled. Account-scoped: a foreign id → 404.
//
// Response (200): { "data": { "id", "status": "cancelled" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { cancelBroadcast } from '@/lib/queue/broadcast-controls';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;
    const result = await cancelBroadcast(id, ctx.accountId);
    if (!result.ok) {
      if (result.code === 'not_found')
        return fail('not_found', 'Broadcast not found', 404);
      return fail('invalid_state', result.message ?? 'Invalid state', 409);
    }
    return ok({ id, status: result.status });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

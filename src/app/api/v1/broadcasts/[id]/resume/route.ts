// ============================================================
// POST /api/v1/broadcasts/{id}/resume — resume a paused broadcast
// (scope: broadcasts:send). Sets status back to 'sending' and re-enqueues
// the dispatch so any not-yet-fanned-out recipients get queued. Only valid
// from 'paused'. Account-scoped: a foreign id → 404.
//
// Response (200): { "data": { "id", "status": "sending" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resumeBroadcast } from '@/lib/queue/broadcast-controls';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;
    const result = await resumeBroadcast(id, ctx.accountId);
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

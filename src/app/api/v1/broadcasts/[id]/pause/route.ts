// ============================================================
// POST /api/v1/broadcasts/{id}/pause — pause an in-flight or scheduled
// broadcast (scope: broadcasts:send).
//
// Only valid from 'sending' or 'scheduled'. Queued recipient jobs
// self-defer while paused and resume when the broadcast is resumed.
// Account-scoped: a foreign id → 404.
//
// Response (200): { "data": { "id", "status": "paused" } }
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { logBroadcastEvent } from '@/lib/broadcasts/audit';
import { pauseBroadcast } from '@/lib/queue/broadcast-controls';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const { id } = await params;
    // 15/09 (GoLink): "Pausado por <quem>" — pela API é quem criou a chave.
    const result = await pauseBroadcast(id, ctx.accountId, ctx.createdBy);
    if (!result.ok) {
      if (result.code === 'not_found')
        return fail('not_found', 'Broadcast not found', 404);
      return fail('invalid_state', result.message ?? 'Invalid state', 409);
    }
    // Rastro em broadcast_events (revisão 15/09); nunca lança.
    await logBroadcastEvent({
      action: 'pause',
      broadcastId: id,
      accountId: ctx.accountId,
      userId: ctx.createdBy,
      role: 'api_key',
      previousStatus: result.previousStatus,
      extra: { keyId: ctx.keyId },
    });
    return ok({ id, status: result.status });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

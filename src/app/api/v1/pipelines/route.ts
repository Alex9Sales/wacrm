// ============================================================
// GET /api/v1/pipelines — list the account's pipelines, each with its
// ordered stages (scope: deals:read). Small, unpaginated (an account has a
// handful of pipelines). Use these ids to place/move deals.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { listPipelinesWithStages } from '@/lib/api/v1/deals';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const pipelines = await listPipelinesWithStages(ctx.accountId);
    return ok({ pipelines });
  } catch (err) {
    if (err instanceof Error && err.name === 'DealError') {
      return fail('bad_request', err.message, 400);
    }
    return toApiErrorResponse(err);
  }
}

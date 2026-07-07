// ============================================================
// GET   /api/v1/deals/{id}  — get one deal.            scope: deals:read
// PATCH /api/v1/deals/{id}  — update / MOVE a deal.    scope: deals:write
//
// PATCH is how a card moves on the Kanban: pass `stage_id` (and optionally
// `pipeline_id`) to move it; other fields (title/value/currency/notes/
// status/contact_id/expected_close_date) update in place. Only provided
// fields change. No DELETE — deletion stays dashboard-only (human-gated).
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, deals, contacts } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  getDealById,
  assertPipelineOwned,
  assertStageInPipeline,
  DealError,
} from '@/lib/api/v1/deals';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'deals:read');
    const { id } = await params;
    const deal = await getDealById(ctx.accountId, id);
    if (!deal) return fail('not_found', 'Deal not found', 404);
    return ok(deal);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');
    const { id } = await params;

    const current = firstOrNull(
      await db
        .select({
          id: deals.id,
          pipelineId: deals.pipelineId,
          stageId: deals.stageId,
        })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    );
    if (!current) return fail('not_found', 'Deal not found', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const set: Record<string, unknown> = {};

    // Pipeline / stage move. If pipeline_id changes, a stage_id in the new
    // pipeline is required (a stage only makes sense within its pipeline).
    let targetPipeline = current.pipelineId;
    if (typeof body.pipeline_id === 'string' && body.pipeline_id) {
      await assertPipelineOwned(ctx.accountId, body.pipeline_id);
      targetPipeline = body.pipeline_id;
      set.pipelineId = body.pipeline_id;
    }
    if (typeof body.stage_id === 'string' && body.stage_id) {
      await assertStageInPipeline(targetPipeline, body.stage_id);
      set.stageId = body.stage_id;
    } else if (set.pipelineId) {
      return fail(
        'bad_request',
        'stage_id is required when changing pipeline_id',
        400,
      );
    }

    if (typeof body.title === 'string') set.title = body.title.trim();
    if (body.value != null && !Number.isNaN(Number(body.value))) {
      set.value = String(Number(body.value));
    }
    if (typeof body.currency === 'string') set.currency = body.currency;
    if (typeof body.notes === 'string' || body.notes === null) {
      set.notes = body.notes;
    }
    if (typeof body.status === 'string') set.status = body.status;
    if (
      typeof body.expected_close_date === 'string' ||
      body.expected_close_date === null
    ) {
      set.expectedCloseDate = body.expected_close_date;
    }
    if (typeof body.contact_id === 'string' && body.contact_id) {
      const owned = firstOrNull(
        await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, body.contact_id),
              eq(contacts.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      );
      if (!owned) return fail('bad_request', 'contact_id not found', 400);
      set.contactId = body.contact_id;
    } else if (body.contact_id === null) {
      set.contactId = null;
    }

    if (Object.keys(set).length === 0) {
      // Nothing to change — return the current row rather than erroring.
      const deal = await getDealById(ctx.accountId, id);
      return ok(deal);
    }

    set.updatedAt = new Date().toISOString();
    await db
      .update(deals)
      .set(set)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)));

    const deal = await getDealById(ctx.accountId, id);
    return ok(deal);
  } catch (err) {
    if (err instanceof DealError) {
      return fail(err.status === 400 ? 'bad_request' : 'not_found', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

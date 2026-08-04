// ============================================================
// GET    /api/v1/deals/{id}  — get one deal.                    scope: deals:read
// PATCH  /api/v1/deals/{id}  — move/assign OR edit a deal.      scopes below
// DELETE /api/v1/deals/{id}  — delete a deal (permanent).       scope: deals:delete
//
// PATCH is scope-split so an agent can operate the funnel without editing/
// deleting (Alex's model):
//   • move (stage_id/pipeline_id) + assign/unassign (assigned_to) → deals:write
//   • edit fields (title/value/currency/notes/status/date/contact) → deals:edit
// A body that touches both classes needs both scopes. Assigning records a
// 'transferred' event in the deal's history and notifies the new assignee.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, deals, contacts, dealEvents, notifications, member, user } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, forbidden, toApiErrorResponse } from '@/lib/api/v1/respond';
import { hasScope } from '@/lib/api-keys/scopes';
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
    // Auth only — the specific scope depends on WHICH fields the body touches
    // (move/assign → deals:write; edit → deals:edit), checked below.
    const ctx = await requireApiKey(request);
    const { id } = await params;

    const current = firstOrNull(
      await db
        .select({
          id: deals.id,
          pipelineId: deals.pipelineId,
          stageId: deals.stageId,
          assignedTo: deals.assignedTo,
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

    // Classify the requested change: move/assign (deals:write) vs edit
    // (deals:edit). Enforce per-class so a write-only key can't edit fields.
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const touchesMove =
      has('pipeline_id') || has('stage_id') || has('assigned_to');
    const CONTENT_KEYS = [
      'title',
      'value',
      'currency',
      'notes',
      'status',
      'expected_close_date',
      'contact_id',
    ];
    const touchesEdit = CONTENT_KEYS.some((k) => has(k));
    if (touchesMove && !hasScope(ctx.scopes, 'deals:write')) {
      throw forbidden('Moving/assigning a deal requires the deals:write scope');
    }
    if (touchesEdit && !hasScope(ctx.scopes, 'deals:edit')) {
      throw forbidden('Editing deal fields requires the deals:edit scope');
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

    // Assign / unassign. `assigned_to: null` clears it; a user id must be a
    // member of the account.
    let newAssignee: string | null | undefined;
    if (has('assigned_to')) {
      if (body.assigned_to === null) {
        set.assignedTo = null;
        newAssignee = null;
      } else if (typeof body.assigned_to === 'string' && body.assigned_to) {
        const isMember = firstOrNull(
          await db
            .select({ userId: member.userId })
            .from(member)
            .where(
              and(
                eq(member.userId, body.assigned_to),
                eq(member.organizationId, ctx.accountId),
              ),
            )
            .limit(1),
        );
        if (!isMember) return fail('bad_request', 'assigned_to is not a member of this account', 400);
        set.assignedTo = body.assigned_to;
        newAssignee = body.assigned_to;
      }
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

    // Assignment changed → record it in the deal history + notify the new
    // assignee (mirrors the in-app "transferir lead"). Best-effort.
    if (newAssignee !== undefined && newAssignee !== current.assignedTo) {
      try {
        const toName = newAssignee
          ? (
              firstOrNull(
                await db.select({ name: user.name }).from(user).where(eq(user.id, newAssignee)).limit(1),
              )
            )?.name?.trim() || null
          : null;
        await db.insert(dealEvents).values({
          accountId: ctx.accountId,
          actorUserId: null,
          dealId: id,
          type: 'transferred',
          data: { to: toName, via: 'api' },
        });
        if (newAssignee) {
          await db.insert(notifications).values({
            accountId: ctx.accountId,
            userId: newAssignee,
            type: 'deal_transferred',
            dealId: id,
            title: 'Lead atribuído a você',
            body: 'Um lead foi atribuído a você pela integração.',
          });
        }
      } catch (err) {
        console.error('[api deals PATCH] assign side-effects failed:', err);
      }
    }

    const deal = await getDealById(ctx.accountId, id);
    return ok(deal);
  } catch (err) {
    if (err instanceof DealError) {
      return fail(err.status === 400 ? 'bad_request' : 'not_found', err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Delete is the sensitive action, gated behind its own scope so an
    // operate-only agent key can never remove a deal (Alex's model).
    const ctx = await requireApiKey(request, 'deals:delete');
    const { id } = await params;
    const existing = firstOrNull(
      await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
        .limit(1),
    );
    if (!existing) return fail('not_found', 'Deal not found', 404);
    await db
      .delete(deals)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)));
    return ok({ id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

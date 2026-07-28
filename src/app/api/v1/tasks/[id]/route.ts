// ============================================================
// GET   /api/v1/tasks/{id}  — read one task.        scope: tasks:read
// PATCH /api/v1/tasks/{id}  — update a task.         scope: tasks:write
//
// PATCH touches only the fields you send. Mark done by sending
// `{ "status": "done" }`. Contact/deal links are re-validated against
// the account. A task in another account returns 404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, tasks } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  serializeTask,
  getTaskById,
  assertOwnedContact,
  assertOwnedDeal,
  isTaskStatus,
  TaskApiError,
} from '@/lib/api/v1/tasks';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'tasks:read');
    const { id } = await context.params;
    const row = await getTaskById(ctx.accountId, id);
    if (!row) return fail('not_found', 'Task not found', 404);
    return ok(serializeTask(row));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'tasks:write');
    const { id } = await context.params;

    const existing = await getTaskById(ctx.accountId, id);
    if (!existing) return fail('not_found', 'Task not found', 404);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const set: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) return fail('bad_request', "'title' cannot be empty", 400);
      set.title = title;
    }
    if (body.description !== undefined) {
      set.description =
        typeof body.description === 'string' ? body.description.trim() || null : null;
    }
    if (body.due_at !== undefined) {
      set.dueAt = typeof body.due_at === 'string' && body.due_at ? body.due_at : null;
    }
    if (body.status !== undefined) {
      if (!isTaskStatus(body.status)) {
        return fail('bad_request', "status must be 'open', 'done' or 'cancelled'", 400);
      }
      set.status = body.status;
    }
    if (body.type !== undefined) {
      set.type = typeof body.type === 'string' ? body.type.trim() || null : null;
    }
    try {
      if (body.contact_id !== undefined) {
        set.contactId = await assertOwnedContact(ctx.accountId, body.contact_id);
      }
      if (body.deal_id !== undefined) {
        set.dealId = await assertOwnedDeal(ctx.accountId, body.deal_id);
      }
    } catch (err) {
      if (err instanceof TaskApiError) return fail('bad_request', err.message, err.status);
      throw err;
    }
    if (body.assigned_to !== undefined) {
      set.assignedTo =
        typeof body.assigned_to === 'string' && body.assigned_to
          ? body.assigned_to
          : null;
    }

    if (Object.keys(set).length === 0) {
      return ok(serializeTask(existing));
    }
    set.updatedAt = new Date().toISOString();

    try {
      await db
        .update(tasks)
        .set(set)
        .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)));
    } catch (error) {
      console.error('[api/v1/tasks] update error:', error);
      return fail('internal', 'Failed to update task', 500);
    }

    const row = await getTaskById(ctx.accountId, id);
    if (!row) return fail('not_found', 'Task not found', 404);
    return ok(serializeTask(row));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

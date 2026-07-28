// ============================================================
// GET  /api/v1/tasks  — list tasks.            scope: tasks:read
// POST /api/v1/tasks  — create a task.         scope: tasks:write
//
// List is keyset-paginated (created_at desc, id desc) and supports
// `?status=` (open|done|cancelled), `?contact_id=`, `?deal_id=`,
// `?assigned_to=` filters. Create needs only `title`; contact/deal/
// assignee links are optional and validated against the account.
// ============================================================

import { and, desc, eq, lt, or } from 'drizzle-orm';

import { db, tasks } from '@/db';
import { firstOrThrow } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { okList, ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import {
  TASK_COLUMNS,
  serializeTask,
  getTaskById,
  assertOwnedContact,
  assertOwnedDeal,
  isTaskStatus,
  TaskApiError,
} from '@/lib/api/v1/tasks';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tasks:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    const conditions = [eq(tasks.accountId, ctx.accountId)];
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    const dealId = url.searchParams.get('deal_id');
    const assignedTo = url.searchParams.get('assigned_to');
    if (status) conditions.push(eq(tasks.status, status));
    if (contactId) conditions.push(eq(tasks.contactId, contactId));
    if (dealId) conditions.push(eq(tasks.dealId, dealId));
    if (assignedTo) conditions.push(eq(tasks.assignedTo, assignedTo));

    if (cursor) {
      conditions.push(
        or(
          lt(tasks.createdAt, cursor.createdAt),
          and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id)),
        )!,
      );
    }

    let rows: Array<Record<string, unknown> & { created_at: string; id: string }>;
    try {
      rows = (await db
        .select(TASK_COLUMNS)
        .from(tasks)
        .where(and(...conditions))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit + 1)) as never;
    } catch (error) {
      console.error('[api/v1/tasks] list error:', error);
      return fail('internal', 'Failed to list tasks', 500);
    }

    const { items, nextCursor } = buildPage(rows, limit);
    return okList(
      items.map((r) => serializeTask(r as Record<string, unknown>)),
      nextCursor,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tasks:write');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return fail('bad_request', "'title' is required", 400);

    if (body.status !== undefined && !isTaskStatus(body.status)) {
      return fail('bad_request', "status must be 'open', 'done' or 'cancelled'", 400);
    }

    let contactId: string | null;
    let dealId: string | null;
    try {
      contactId = await assertOwnedContact(ctx.accountId, body.contact_id);
      dealId = await assertOwnedDeal(ctx.accountId, body.deal_id);
    } catch (err) {
      if (err instanceof TaskApiError) return fail('bad_request', err.message, err.status);
      throw err;
    }

    const inserted = firstOrThrow(
      await db
        .insert(tasks)
        .values({
          accountId: ctx.accountId,
          title,
          description:
            typeof body.description === 'string' ? body.description.trim() || null : null,
          dueAt: typeof body.due_at === 'string' && body.due_at ? body.due_at : null,
          status: isTaskStatus(body.status) ? body.status : 'open',
          type: typeof body.type === 'string' ? body.type.trim() || null : null,
          contactId,
          dealId,
          assignedTo:
            typeof body.assigned_to === 'string' && body.assigned_to
              ? body.assigned_to
              : null,
        })
        .returning({ id: tasks.id }),
    );

    const row = await getTaskById(ctx.accountId, inserted.id);
    if (!row) return fail('internal', 'Failed to create task', 500);
    return ok(serializeTask(row), 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

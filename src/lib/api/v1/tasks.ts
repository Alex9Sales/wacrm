// ============================================================
// Public API — tasks resource helpers (serialization + ownership).
//
// Mirrors the deals helpers: a column map for list/get, a serializer to
// the wire shape, ownership assertions for the optional contact/deal links,
// and a small TaskApiError the routes map to a 400/404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, tasks, contacts, deals } from '@/db';
import { firstOrNull } from '@/db/helpers';

export class TaskApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'TaskApiError';
    this.status = status;
  }
}

/** Columns selected for list/get. `created_at`/`id` power keyset pagination. */
export const TASK_COLUMNS = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  due_at: tasks.dueAt,
  status: tasks.status,
  type: tasks.type,
  contact_id: tasks.contactId,
  deal_id: tasks.dealId,
  assigned_to: tasks.assignedTo,
  created_at: tasks.createdAt,
  updated_at: tasks.updatedAt,
} as const;

export interface SerializedTask {
  id: string;
  title: string;
  description: string | null;
  due_at: string | null;
  status: string;
  type: string | null;
  contact_id: string | null;
  deal_id: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export function serializeTask(row: Record<string, unknown>): SerializedTask {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    due_at: (row.due_at as string | null) ?? null,
    status: row.status as string,
    type: (row.type as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    deal_id: (row.deal_id as string | null) ?? null,
    assigned_to: (row.assigned_to as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export async function getTaskById(
  accountId: string,
  id: string,
): Promise<(Record<string, unknown> & { created_at: string; id: string }) | null> {
  const row = firstOrNull(
    await db
      .select(TASK_COLUMNS)
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.accountId, accountId)))
      .limit(1),
  );
  return (row as never) ?? null;
}

/** Valid task statuses (mirrors the DB check constraint). */
export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

/** A contact id the account owns, or throw. `null` clears the link. */
export async function assertOwnedContact(
  accountId: string,
  raw: unknown,
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new TaskApiError('contact_id must be a string');
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, raw), eq(contacts.accountId, accountId)))
      .limit(1),
  );
  if (!owned) throw new TaskApiError('contact_id not found', 400);
  return raw;
}

/** A deal id the account owns, or throw. `null` clears the link. */
export async function assertOwnedDeal(
  accountId: string,
  raw: unknown,
): Promise<string | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new TaskApiError('deal_id must be a string');
  const owned = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, raw), eq(deals.accountId, accountId)))
      .limit(1),
  );
  if (!owned) throw new TaskApiError('deal_id not found', 400);
  return raw;
}

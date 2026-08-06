'use server'

// ============================================================
// Server actions for the Tarefas (Tasks) subsystem. Every query is
// account-scoped via getCurrentAccount / requireRole — there is no
// RLS. Reads require any membership; mutations require agent+.
//
// The listing joins each task to its contact (client name/phone) and
// its deal (Kanban card title + pipeline) so the table can show the
// client without a second round-trip. Ordering surfaces overdue tasks
// first, then soonest due, then newest.
//
// createTask accepts an optional contactId / dealId so the NEXT wave
// (inbox-sidebar + Kanban-card "criar tarefa") can call it prefilled
// without any new server code.
// ============================================================

import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  db,
  tasks,
  contacts,
  deals,
  pipelines,
  user,
} from '@/db'

// Aliased `user` joins so a task can carry BOTH its creator's and its
// assignee's display name (who made it / whose it is) — Felipe's ask.
const taskCreator = alias(user, 'task_creator')
const taskAssignee = alias(user, 'task_assignee')
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'

/**
 * Task visibility (spec Alex): an agent/viewer sees ONLY their own tasks —
 * assigned to them OR created by them. Admin/supervisor see every task in the
 * account. Returns undefined (no extra filter) for admin+; a WHERE clause
 * otherwise. `and(accountCond, taskVisibilityFor(ctx))` tolerates undefined.
 */
function taskVisibilityFor(ctx: {
  role: import('@/lib/auth/roles').AccountRole
  userId: string
}) {
  if (hasMinRole(ctx.role, 'supervisor')) return undefined
  return or(eq(tasks.assignedTo, ctx.userId), eq(tasks.createdBy, ctx.userId))
}

// ------------------------------------------------------------
// Public shapes
// ------------------------------------------------------------

export type TaskStatus = 'open' | 'done' | 'cancelled'

/** One task row hydrated with its linked contact + deal (for the table). */
export interface TaskRow {
  id: string
  account_id: string
  title: string
  description: string | null
  due_at: string | null
  status: TaskStatus
  type: string | null
  contact_id: string | null
  deal_id: string | null
  assigned_to: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  /** Denormalized for display — null when unlinked / deleted. */
  contact_name: string | null
  contact_phone: string | null
  deal_title: string | null
  pipeline_name: string | null
  /** Who created the task / who it's assigned to (display names). */
  created_by_name: string | null
  assigned_to_name: string | null
  /** Computed server-side (due_at < now AND status='open'). */
  overdue: boolean
}

export interface TaskOverview {
  total: number
  open: number
  overdue: number
  dueToday: number
}

/** Lightweight option for the searchable pickers (choose by name). */
export interface PickerOption {
  id: string
  label: string
  /** Extra hint shown under the label (phone / pipeline). */
  sublabel: string | null
}

export interface ListTasksInput {
  /** 'open' | 'done' | 'cancelled' | 'overdue' | undefined (= all). */
  status?: TaskStatus | 'overdue'
  /** Free-text search over title / type / contact name / deal title. */
  search?: string
}

// Shared column selection for a task joined to contact + deal + pipeline.
const taskSelect = {
  id: tasks.id,
  account_id: tasks.accountId,
  title: tasks.title,
  description: tasks.description,
  due_at: tasks.dueAt,
  status: tasks.status,
  type: tasks.type,
  contact_id: tasks.contactId,
  deal_id: tasks.dealId,
  assigned_to: tasks.assignedTo,
  created_by: tasks.createdBy,
  created_at: tasks.createdAt,
  updated_at: tasks.updatedAt,
  contact_name: contacts.name,
  contact_phone: contacts.phone,
  deal_title: deals.title,
  pipeline_name: pipelines.name,
  created_by_name: taskCreator.name,
  assigned_to_name: taskAssignee.name,
  overdue: sql<boolean>`(${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW() AND ${tasks.status} = 'open')`,
}

function toTaskRow(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    account_id: r.account_id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    status: r.status as TaskStatus,
    type: (r.type as string | null) ?? null,
    contact_id: (r.contact_id as string | null) ?? null,
    deal_id: (r.deal_id as string | null) ?? null,
    assigned_to: (r.assigned_to as string | null) ?? null,
    created_by: (r.created_by as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    contact_name: (r.contact_name as string | null) ?? null,
    contact_phone: (r.contact_phone as string | null) ?? null,
    deal_title: (r.deal_title as string | null) ?? null,
    pipeline_name: (r.pipeline_name as string | null) ?? null,
    created_by_name: (r.created_by_name as string | null) ?? null,
    assigned_to_name: (r.assigned_to_name as string | null) ?? null,
    overdue: Boolean(r.overdue),
  }
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------

/**
 * List the account's tasks, joined to contact + deal for display.
 * Ordering: overdue first, then by due_at asc (nulls last), then
 * created_at desc. Optional status filter ('overdue' = open & past due)
 * and free-text search over title/type/contact/deal.
 */
export async function listTasks(input: ListTasksInput = {}): Promise<TaskRow[]> {
  const ctx = await getCurrentAccount()
  const term = (input.search ?? '').trim()

  const conditions = [eq(tasks.accountId, ctx.accountId)]
  const vis = taskVisibilityFor(ctx)
  if (vis) conditions.push(vis)

  if (input.status === 'overdue') {
    conditions.push(
      sql`${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW() AND ${tasks.status} = 'open'`,
    )
  } else if (input.status) {
    conditions.push(eq(tasks.status, input.status))
  }

  if (term) {
    const like = `%${term}%`
    const searchCond = or(
      ilike(tasks.title, like),
      ilike(tasks.type, like),
      ilike(contacts.name, like),
      ilike(contacts.phone, like),
      ilike(deals.title, like),
    )
    if (searchCond) conditions.push(searchCond)
  }

  const rows = await db
    .select(taskSelect)
    .from(tasks)
    .leftJoin(contacts, eq(tasks.contactId, contacts.id))
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .leftJoin(pipelines, eq(deals.pipelineId, pipelines.id))
    .leftJoin(taskCreator, eq(tasks.createdBy, taskCreator.id))
    .leftJoin(taskAssignee, eq(tasks.assignedTo, taskAssignee.id))
    .where(and(...conditions))
    .orderBy(
      // Overdue (open + past due) bubble to the top.
      desc(
        sql`(${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW() AND ${tasks.status} = 'open')`,
      ),
      // Then soonest due; NULLs (no deadline) sink to the bottom.
      sql`${tasks.dueAt} ASC NULLS LAST`,
      desc(tasks.createdAt),
    )

  return rows.map((r) => toTaskRow(r as Record<string, unknown>))
}

/**
 * Aggregate counts for the nav badge + page header. `overdue` and
 * `dueToday` both count only OPEN tasks (a done/cancelled task never
 * alerts). dueToday compares on the account server's local date.
 */
export async function getTasksOverview(): Promise<TaskOverview> {
  const ctx = await getCurrentAccount()
  const row = firstOrThrow(
    await db
      .select({
        total: sql<number>`COUNT(*)::int`,
        open: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'open')::int`,
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW())::int`,
        dueToday: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt}::date = CURRENT_DATE)::int`,
      })
      .from(tasks)
      .where(and(eq(tasks.accountId, ctx.accountId), taskVisibilityFor(ctx))),
  )
  return {
    total: Number(row.total ?? 0),
    open: Number(row.open ?? 0),
    overdue: Number(row.overdue ?? 0),
    dueToday: Number(row.dueToday ?? 0),
  }
}

/** One task (hydrated) by id, scoped to the account. */
export async function getTask(id: string): Promise<TaskRow | null> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(taskSelect)
    .from(tasks)
    .leftJoin(contacts, eq(tasks.contactId, contacts.id))
    .leftJoin(deals, eq(tasks.dealId, deals.id))
    .leftJoin(pipelines, eq(deals.pipelineId, pipelines.id))
    .leftJoin(taskCreator, eq(tasks.createdBy, taskCreator.id))
    .leftJoin(taskAssignee, eq(tasks.assignedTo, taskAssignee.id))
    .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)))
    .limit(1)
  const row = firstOrNull(rows)
  return row ? toTaskRow(row as Record<string, unknown>) : null
}

// ------------------------------------------------------------
// Compact task shape for the inbox sidebar + Kanban card. Minimal
// columns (no joins) — the caller already knows the contact/deal.
// ------------------------------------------------------------

export interface TaskLite {
  id: string
  title: string
  due_at: string | null
  status: TaskStatus
  type: string | null
  /** Computed server-side (due_at < now AND status='open'). */
  overdue: boolean
}

const taskLiteSelect = {
  id: tasks.id,
  title: tasks.title,
  due_at: tasks.dueAt,
  status: tasks.status,
  type: tasks.type,
  overdue: sql<boolean>`(${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW() AND ${tasks.status} = 'open')`,
}

function toTaskLite(r: Record<string, unknown>): TaskLite {
  return {
    id: r.id as string,
    title: r.title as string,
    due_at: (r.due_at as string | null) ?? null,
    status: r.status as TaskStatus,
    type: (r.type as string | null) ?? null,
    overdue: Boolean(r.overdue),
  }
}

// Shared ordering: open tasks first, then overdue bubble up, soonest
// due next (NULLs last), newest last.
const liteOrderBy = [
  // 'open' before done/cancelled.
  sql`(${tasks.status} = 'open') DESC`,
  desc(
    sql`(${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW() AND ${tasks.status} = 'open')`,
  ),
  sql`${tasks.dueAt} ASC NULLS LAST`,
  desc(tasks.createdAt),
] as const

/**
 * A contact's tasks (account-scoped), open first then by due date.
 * Powers the inbox sidebar "Tarefas" section. Minimal columns — no
 * contact/deal joins since the caller already has the contact.
 */
export async function listTasksByContact(contactId: string): Promise<TaskLite[]> {
  const ctx = await getCurrentAccount()
  const id = cleanText(contactId)
  if (!id) return []
  const rows = await db
    .select(taskLiteSelect)
    .from(tasks)
    .where(and(eq(tasks.accountId, ctx.accountId), eq(tasks.contactId, id)))
    .orderBy(...liteOrderBy)
  return rows.map((r) => toTaskLite(r as Record<string, unknown>))
}

/**
 * A deal's (Kanban card's) tasks (account-scoped), open first then by
 * due date. Powers the Kanban card task list + indicator.
 */
export async function listTasksByDeal(dealId: string): Promise<TaskLite[]> {
  const ctx = await getCurrentAccount()
  const id = cleanText(dealId)
  if (!id) return []
  const rows = await db
    .select(taskLiteSelect)
    .from(tasks)
    .where(and(eq(tasks.accountId, ctx.accountId), eq(tasks.dealId, id)))
    .orderBy(...liteOrderBy)
  return rows.map((r) => toTaskLite(r as Record<string, unknown>))
}

export interface DealTaskCount {
  /** Open (not done/cancelled) task count for the deal. */
  open: number
  /** Of the open ones, how many are overdue. */
  overdue: number
}

/**
 * Batched open-task counts for a set of deals — one query for the
 * whole visible board (avoids N+1 per card). Returns a map keyed by
 * deal id; deals with no open tasks are simply absent from the map.
 */
export async function getDealTaskCounts(
  dealIds: string[],
): Promise<Record<string, DealTaskCount>> {
  const ctx = await getCurrentAccount()
  const ids = Array.from(
    new Set(dealIds.map((d) => cleanText(d)).filter((d): d is string => !!d)),
  )
  if (ids.length === 0) return {}

  const rows = await db
    .select({
      deal_id: tasks.dealId,
      open: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'open')::int`,
      overdue: sql<number>`COUNT(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} IS NOT NULL AND ${tasks.dueAt} < NOW())::int`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.accountId, ctx.accountId),
        inArray(tasks.dealId, ids),
        eq(tasks.status, 'open'),
      ),
    )
    .groupBy(tasks.dealId)

  const map: Record<string, DealTaskCount> = {}
  for (const r of rows) {
    if (!r.deal_id) continue
    const open = Number(r.open ?? 0)
    if (open === 0) continue
    map[r.deal_id] = { open, overdue: Number(r.overdue ?? 0) }
  }
  return map
}

// ------------------------------------------------------------
// Pickers (choose client / Kanban card by NAME, never by id)
// ------------------------------------------------------------

/** Account contacts as {id,label,sublabel} for the searchable picker. */
export async function listContactsForPicker(): Promise<PickerOption[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
    .from(contacts)
    .where(eq(contacts.accountId, ctx.accountId))
    .orderBy(asc(contacts.name))
  return rows.map((r) => ({
    id: r.id,
    label: (r.name && r.name.trim()) || r.phone,
    sublabel: r.name && r.name.trim() ? r.phone : null,
  }))
}

/** Account deals (Kanban cards) as {id,label,sublabel} for the picker. */
export async function listDealsForPicker(): Promise<PickerOption[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: deals.id,
      title: deals.title,
      pipeline_name: pipelines.name,
    })
    .from(deals)
    .leftJoin(pipelines, eq(deals.pipelineId, pipelines.id))
    .where(eq(deals.accountId, ctx.accountId))
    .orderBy(asc(deals.title))
  return rows.map((r) => ({
    id: r.id,
    label: r.title,
    sublabel: r.pipeline_name ?? null,
  }))
}

// ------------------------------------------------------------
// Mutations (agent+)
// ------------------------------------------------------------

export interface CreateTaskInput {
  title: string
  description?: string | null
  /** ISO string / datetime-local value; '' or null clears the deadline. */
  dueAt?: string | null
  status?: TaskStatus
  type?: string | null
  contactId?: string | null
  dealId?: string | null
  assignedTo?: string | null
}

/** Normalize a datetime-local (or ISO) string into a value pg accepts. */
function normalizeDueAt(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Validate that an optional contact/deal id belongs to the account.
 * Returns the id if valid, null if unset. Throws on a foreign id so a
 * client can't attach another account's records.
 */
async function assertOwnedContact(
  accountId: string,
  contactId: string | null | undefined,
): Promise<string | null> {
  const id = cleanText(contactId)
  if (!id) return null
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, id), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  if (!owned) throw new Error('Contact not found')
  return id
}

async function assertOwnedDeal(
  accountId: string,
  dealId: string | null | undefined,
): Promise<string | null> {
  const id = cleanText(dealId)
  if (!id) return null
  const owned = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.accountId, accountId)))
      .limit(1),
  )
  if (!owned) throw new Error('Deal not found')
  return id
}

/**
 * Create a task. `contactId` / `dealId` are validated against the
 * account. Designed so the inbox sidebar + Kanban card (next wave) can
 * call this with a prefilled contactId/dealId. Returns the new task
 * (hydrated) on success.
 */
export async function createTask(
  input: CreateTaskInput,
): Promise<{ ok: true; task: TaskRow } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const title = input.title.trim()
    if (!title) return { ok: false, error: 'O título é obrigatório.' }

    const status: TaskStatus = input.status ?? 'open'
    const contactId = await assertOwnedContact(ctx.accountId, input.contactId)
    const dealId = await assertOwnedDeal(ctx.accountId, input.dealId)

    const inserted = await db
      .insert(tasks)
      .values({
        accountId: ctx.accountId,
        title,
        description: cleanText(input.description),
        dueAt: normalizeDueAt(input.dueAt),
        status,
        type: cleanText(input.type),
        contactId,
        dealId,
        assignedTo: cleanText(input.assignedTo),
        createdBy: ctx.userId,
      })
      .returning({ id: tasks.id })
    const id = firstOrThrow(inserted).id
    const task = await getTask(id)
    if (!task) return { ok: false, error: 'Falha ao criar a tarefa.' }
    return { ok: true, task }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao criar a tarefa.',
    }
  }
}

export interface UpdateTaskPatch {
  title?: string
  description?: string | null
  dueAt?: string | null
  status?: TaskStatus
  type?: string | null
  contactId?: string | null
  dealId?: string | null
  assignedTo?: string | null
}

/**
 * Update a task. Only the provided fields are touched. Contact/deal
 * ids are re-validated against the account. Returns the updated task.
 */
export async function updateTask(
  id: string,
  patch: UpdateTaskPatch,
): Promise<{ ok: true; task: TaskRow } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')

    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) return { ok: false, error: 'O título é obrigatório.' }
      set.title = title
    }
    if (patch.description !== undefined) set.description = cleanText(patch.description)
    if (patch.dueAt !== undefined) set.dueAt = normalizeDueAt(patch.dueAt)
    if (patch.status !== undefined) set.status = patch.status
    if (patch.type !== undefined) set.type = cleanText(patch.type)
    if (patch.contactId !== undefined)
      set.contactId = await assertOwnedContact(ctx.accountId, patch.contactId)
    if (patch.dealId !== undefined)
      set.dealId = await assertOwnedDeal(ctx.accountId, patch.dealId)
    if (patch.assignedTo !== undefined) set.assignedTo = cleanText(patch.assignedTo)

    if (Object.keys(set).length === 0) {
      const current = await getTask(id)
      if (!current) return { ok: false, error: 'Tarefa não encontrada.' }
      return { ok: true, task: current }
    }

    const updated = await db
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)))
      .returning({ id: tasks.id })
    if (!firstOrNull(updated)) return { ok: false, error: 'Tarefa não encontrada.' }

    const task = await getTask(id)
    if (!task) return { ok: false, error: 'Tarefa não encontrada.' }
    return { ok: true, task }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao atualizar a tarefa.',
    }
  }
}

/** Delete a task (scoped to the account). */
export async function deleteTask(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Falha ao excluir a tarefa.' }
  }
}

/**
 * Toggle a task between 'open' and 'done' (the quick "concluir"
 * action). A 'cancelled' task flips to 'open'. Returns the new status.
 */
export async function toggleTaskDone(
  id: string,
): Promise<{ ok: true; status: TaskStatus } | { ok: false; error: string }> {
  try {
    const ctx = await requireRole('agent')
    const current = firstOrNull(
      await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!current) return { ok: false, error: 'Tarefa não encontrada.' }
    const next: TaskStatus = current.status === 'done' ? 'open' : 'done'
    await db
      .update(tasks)
      .set({ status: next })
      .where(and(eq(tasks.id, id), eq(tasks.accountId, ctx.accountId)))
    return { ok: true, status: next }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao concluir a tarefa.',
    }
  }
}

// ============================================================
// Deal (Kanban card) helpers for the public API v1. Pure data access,
// always account-scoped (there is no RLS — the caller passes ctx.accountId
// and every query filters by it). Mirrors the contacts v1 helper style.
// ============================================================

import { and, asc, eq } from 'drizzle-orm';

import { db, deals, pipelines, pipelineStages } from '@/db';
import { firstOrNull } from '@/db/helpers';

/** Caller-visible failure with a suggested HTTP status. */
export class DealError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DealError';
    this.status = status;
  }
}

/** Public JSON shape of a deal (snake_case, value as a number). */
export interface SerializedDeal {
  id: string;
  title: string;
  value: number;
  currency: string | null;
  status: string | null;
  notes: string | null;
  pipeline_id: string;
  stage_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  assigned_to: string | null;
  expected_close_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const dealColumns = {
  id: deals.id,
  title: deals.title,
  value: deals.value,
  currency: deals.currency,
  status: deals.status,
  notes: deals.notes,
  pipeline_id: deals.pipelineId,
  stage_id: deals.stageId,
  contact_id: deals.contactId,
  conversation_id: deals.conversationId,
  assigned_to: deals.assignedTo,
  expected_close_date: deals.expectedCloseDate,
  created_at: deals.createdAt,
  updated_at: deals.updatedAt,
};

export function serializeDeal(row: Record<string, unknown>): SerializedDeal {
  return {
    id: row.id as string,
    title: row.title as string,
    value: Number(row.value ?? 0),
    currency: (row.currency as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    pipeline_id: row.pipeline_id as string,
    stage_id: row.stage_id as string,
    contact_id: (row.contact_id as string | null) ?? null,
    conversation_id: (row.conversation_id as string | null) ?? null,
    assigned_to: (row.assigned_to as string | null) ?? null,
    expected_close_date: (row.expected_close_date as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

export const DEAL_COLUMNS = dealColumns;

/** One deal by id, account-scoped, serialized. Null when not found. */
export async function getDealById(
  accountId: string,
  id: string,
): Promise<SerializedDeal | null> {
  const row = firstOrNull(
    await db
      .select(dealColumns)
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.accountId, accountId)))
      .limit(1),
  );
  return row ? serializeDeal(row as Record<string, unknown>) : null;
}

/** Assert a pipeline belongs to the account; return it or throw 404. */
export async function assertPipelineOwned(
  accountId: string,
  pipelineId: string,
): Promise<{ id: string }> {
  const p = firstOrNull(
    await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, accountId)))
      .limit(1),
  );
  if (!p) throw new DealError('pipeline_id not found', 404);
  return p;
}

/** Assert a stage belongs to a pipeline; throw 400 otherwise. */
export async function assertStageInPipeline(
  pipelineId: string,
  stageId: string,
): Promise<void> {
  const s = firstOrNull(
    await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.id, stageId),
          eq(pipelineStages.pipelineId, pipelineId),
        ),
      )
      .limit(1),
  );
  if (!s) throw new DealError('stage_id does not belong to the pipeline', 400);
}

/** The account's first stage of a pipeline (lowest position) — used to
 *  default the placement of a newly-created card. */
export async function firstStageOf(pipelineId: string): Promise<string | null> {
  const s = firstOrNull(
    await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position), asc(pipelineStages.id))
      .limit(1),
  );
  return s?.id ?? null;
}

/** The account's first pipeline (oldest) — used to default a card's
 *  pipeline when the caller omits pipeline_id. */
export async function firstPipelineOf(accountId: string): Promise<string | null> {
  const p = firstOrNull(
    await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(eq(pipelines.accountId, accountId))
      .orderBy(asc(pipelines.createdAt), asc(pipelines.id))
      .limit(1),
  );
  return p?.id ?? null;
}

/** All pipelines of an account, each with its ordered stages. */
export async function listPipelinesWithStages(accountId: string): Promise<
  {
    id: string;
    name: string;
    created_at: string | null;
    stages: { id: string; name: string; position: number; color: string }[];
  }[]
> {
  const pRows = await db
    .select({ id: pipelines.id, name: pipelines.name, created_at: pipelines.createdAt })
    .from(pipelines)
    .where(eq(pipelines.accountId, accountId))
    .orderBy(asc(pipelines.createdAt), asc(pipelines.id));
  if (pRows.length === 0) return [];

  const sRows = await db
    .select({
      id: pipelineStages.id,
      pipeline_id: pipelineStages.pipelineId,
      name: pipelineStages.name,
      position: pipelineStages.position,
      color: pipelineStages.color,
    })
    .from(pipelineStages)
    .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
    .where(eq(pipelines.accountId, accountId))
    .orderBy(asc(pipelineStages.position), asc(pipelineStages.id));

  const byPipeline = new Map<string, typeof sRows>();
  for (const s of sRows) {
    const list = byPipeline.get(s.pipeline_id) ?? [];
    list.push(s);
    byPipeline.set(s.pipeline_id, list);
  }

  return pRows.map((p) => ({
    id: p.id,
    name: p.name,
    created_at: p.created_at ?? null,
    stages: (byPipeline.get(p.id) ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      color: s.color,
    })),
  }));
}

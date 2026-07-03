'use server'

// ============================================================
// Server actions for the Pipelines page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Every query is
// scoped to the caller's account — there is no RLS anymore.
// ============================================================

import { and, asc, desc, eq } from 'drizzle-orm'
import { db, contacts, deals, pipelines, pipelineStages, profiles } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Contact, Deal, Pipeline, PipelineStage, Profile } from '@/types'

const contactColumns = {
  id: contacts.id,
  user_id: contacts.userId,
  account_id: contacts.accountId,
  phone: contacts.phone,
  phone_normalized: contacts.phoneNormalized,
  name: contacts.name,
  email: contacts.email,
  company: contacts.company,
  avatar_url: contacts.avatarUrl,
  created_at: contacts.createdAt,
  updated_at: contacts.updatedAt,
}

const profileColumns = {
  id: profiles.id,
  user_id: profiles.userId,
  account_id: profiles.accountId,
  account_role: profiles.accountRole,
  full_name: profiles.fullName,
  email: profiles.email,
  avatar_url: profiles.avatarUrl,
  role: profiles.role,
  beta_features: profiles.betaFeatures,
  created_at: profiles.createdAt,
}

/** The account's pipelines, oldest first (matches the old `.order('created_at')`). */
export async function listPipelines(): Promise<Pipeline[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: pipelines.id,
      user_id: pipelines.userId,
      account_id: pipelines.accountId,
      name: pipelines.name,
      created_at: pipelines.createdAt,
    })
    .from(pipelines)
    .where(eq(pipelines.accountId, ctx.accountId))
    .orderBy(asc(pipelines.createdAt))
  return rows as unknown as Pipeline[]
}

/** Stages of one pipeline (account-scoped through the parent), by position. */
export async function listStages(pipelineId: string): Promise<PipelineStage[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: pipelineStages.id,
      pipeline_id: pipelineStages.pipelineId,
      name: pipelineStages.name,
      position: pipelineStages.position,
      color: pipelineStages.color,
      created_at: pipelineStages.createdAt,
    })
    .from(pipelineStages)
    .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelines.accountId, ctx.accountId)))
    .orderBy(asc(pipelineStages.position))
  return rows as unknown as PipelineStage[]
}

/**
 * Deals of one pipeline with `contact` and `assignee` embedded, newest
 * first. Mirrors the old
 * `select('*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)')`.
 */
export async function listDeals(pipelineId: string): Promise<Deal[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: deals.id,
      user_id: deals.userId,
      account_id: deals.accountId,
      pipeline_id: deals.pipelineId,
      stage_id: deals.stageId,
      contact_id: deals.contactId,
      conversation_id: deals.conversationId,
      assigned_to: deals.assignedTo,
      title: deals.title,
      value: deals.value,
      currency: deals.currency,
      notes: deals.notes,
      expected_close_date: deals.expectedCloseDate,
      status: deals.status,
      created_at: deals.createdAt,
      updated_at: deals.updatedAt,
      contact: contactColumns,
      assignee: profileColumns,
    })
    .from(deals)
    .leftJoin(contacts, eq(deals.contactId, contacts.id))
    .leftJoin(profiles, eq(deals.assignedTo, profiles.id))
    .where(and(eq(deals.pipelineId, pipelineId), eq(deals.accountId, ctx.accountId)))
    .orderBy(desc(deals.createdAt))

  return rows.map((r) => ({
    ...r,
    // numeric comes back as a string from node-postgres; the UI (and the
    // old PostgREST payload) expects a number.
    value: Number(r.value),
    contact: r.contact?.id ? (r.contact as unknown as Contact) : undefined,
    assignee: r.assignee?.id ? (r.assignee as unknown as Profile) : undefined,
  })) as unknown as Deal[]
}

/**
 * Create a pipeline plus its default stages. Used both by the
 * first-visit auto-seed and the "Add Pipeline" dialog.
 */
export async function createPipelineWithStages(
  name: string,
  stages: { name: string; color: string; position: number }[],
): Promise<{ pipeline: Pipeline | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const pipeline = firstOrThrow(
      await db
        .insert(pipelines)
        .values({ userId: ctx.userId, accountId: ctx.accountId, name })
        .returning({
          id: pipelines.id,
          user_id: pipelines.userId,
          account_id: pipelines.accountId,
          name: pipelines.name,
          created_at: pipelines.createdAt,
        }),
    )
    if (stages.length > 0) {
      await db.insert(pipelineStages).values(
        stages.map((s) => ({
          pipelineId: pipeline.id,
          name: s.name,
          color: s.color,
          position: s.position,
        })),
      )
    }
    return { pipeline: pipeline as unknown as Pipeline, error: null }
  } catch (err) {
    return {
      pipeline: null,
      error: err instanceof Error ? err.message : 'Failed to create pipeline',
    }
  }
}

/** Persist a drag-and-drop stage move. Returns an error message or null. */
export async function moveDealToStage(
  dealId: string,
  stageId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(deals)
      .set({ stageId })
      .where(and(eq(deals.id, dealId), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to move deal' }
  }
}

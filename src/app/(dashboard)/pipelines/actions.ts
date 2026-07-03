'use server'

// ============================================================
// Server actions for the Pipelines page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Every query is
// scoped to the caller's account — there is no RLS anymore.
// ============================================================

import { and, asc, count, desc, eq, sql } from 'drizzle-orm'
import { db, contacts, conversations, deals, pipelines, pipelineStages, profiles } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Contact, Conversation, Deal, Pipeline, PipelineStage, Profile } from '@/types'

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

// ============================================================
// Pipeline settings (pipeline-settings.tsx)
// ============================================================

/**
 * Rename a pipeline and upsert its stages in one round-trip. Mirrors the old
 * client-side `pipelines.update(name)` + `pipeline_stages.upsert(..., {onConflict:'id'})`.
 * Account-scoped: the rename filters on accountId and stages are only upserted
 * after confirming the pipeline belongs to the caller.
 */
export async function savePipelineSettings(
  pipelineId: string,
  name: string,
  stages: { id: string; name: string; color: string; position: number }[],
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()

    // Confirm ownership before touching stages (stages have no accountId of
    // their own — ownership flows through the parent pipeline).
    const owned = firstOrNull(
      await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { error: 'Pipeline not found' }

    await db
      .update(pipelines)
      .set({ name: name.trim() })
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId)))

    if (stages.length > 0) {
      await db
        .insert(pipelineStages)
        .values(
          stages.map((s) => ({
            id: s.id,
            pipelineId,
            name: s.name,
            color: s.color,
            position: s.position,
          })),
        )
        .onConflictDoUpdate({
          target: pipelineStages.id,
          set: {
            name: sql`excluded.name`,
            color: sql`excluded.color`,
            position: sql`excluded.position`,
          },
        })
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save pipeline' }
  }
}

/**
 * Add a single stage to a pipeline the caller owns. Returns the created stage
 * in snake_case shape (matches PipelineStage). Mirrors the old
 * `pipeline_stages.insert(...).select().single()`.
 */
export async function addStage(
  pipelineId: string,
  input: { name: string; color: string; position: number },
): Promise<{ stage: PipelineStage | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const owned = firstOrNull(
      await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { stage: null, error: 'Pipeline not found' }

    const stage = firstOrThrow(
      await db
        .insert(pipelineStages)
        .values({
          pipelineId,
          name: input.name,
          color: input.color,
          position: input.position,
        })
        .returning({
          id: pipelineStages.id,
          pipeline_id: pipelineStages.pipelineId,
          name: pipelineStages.name,
          position: pipelineStages.position,
          color: pipelineStages.color,
          created_at: pipelineStages.createdAt,
        }),
    )
    return { stage: stage as unknown as PipelineStage, error: null }
  } catch (err) {
    return { stage: null, error: err instanceof Error ? err.message : 'Failed to add stage' }
  }
}

/** Number of deals in a stage (account-scoped). Guards stage deletion. */
export async function countDealsInStage(stageId: string): Promise<number> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({ value: count() })
      .from(deals)
      .where(and(eq(deals.stageId, stageId), eq(deals.accountId, ctx.accountId))),
  )
  return row?.value ?? 0
}

/**
 * Delete a stage the caller owns (ownership via parent pipeline). The caller
 * should confirm no deals reference it first (see countDealsInStage).
 */
export async function deleteStage(stageId: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    // Only delete stages whose parent pipeline belongs to the caller.
    const owned = firstOrNull(
      await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .innerJoin(pipelines, eq(pipelineStages.pipelineId, pipelines.id))
        .where(and(eq(pipelineStages.id, stageId), eq(pipelines.accountId, ctx.accountId))),
    )
    if (!owned) return { error: 'Stage not found' }

    await db.delete(pipelineStages).where(eq(pipelineStages.id, stageId))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete stage' }
  }
}

/** Delete a pipeline the caller owns. ON DELETE CASCADE removes deals + stages. */
export async function deletePipeline(pipelineId: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(pipelines)
      .where(and(eq(pipelines.id, pipelineId), eq(pipelines.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete pipeline' }
  }
}

// ============================================================
// Deal form (deal-form.tsx)
// ============================================================

/** All contacts in the account, ordered by name (matches the old `.order('name')`). */
export async function listContactsForDeal(): Promise<Contact[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(contactColumns)
    .from(contacts)
    .where(eq(contacts.accountId, ctx.accountId))
    .orderBy(asc(contacts.name))
  return rows as unknown as Contact[]
}

/** All profiles (potential assignees) in the account, ordered by full_name. */
export async function listAssignees(): Promise<Profile[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(profileColumns)
    .from(profiles)
    .where(eq(profiles.accountId, ctx.accountId))
    .orderBy(asc(profiles.fullName))
  return rows as unknown as Profile[]
}

/**
 * Newest conversation for a contact (account-scoped), or null. Mirrors the old
 * `conversations.select().eq('contact_id').order('last_message_at desc').limit(1).maybeSingle()`.
 */
export async function listConversationsForContact(
  contactId: string,
): Promise<Conversation | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        id: conversations.id,
        user_id: conversations.userId,
        account_id: conversations.accountId,
        contact_id: conversations.contactId,
        status: conversations.status,
        assigned_agent_id: conversations.assignedAgentId,
        last_message_text: conversations.lastMessageText,
        last_message_at: conversations.lastMessageAt,
        unread_count: conversations.unreadCount,
        created_at: conversations.createdAt,
        updated_at: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(eq(conversations.contactId, contactId), eq(conversations.accountId, ctx.accountId)),
      )
      .orderBy(desc(conversations.lastMessageAt))
      .limit(1),
  )
  return row as unknown as Conversation | null
}

export interface DealInput {
  title: string
  value: number
  currency: string
  contact_id: string
  pipeline_id: string
  stage_id: string
  assigned_to: string | null
  notes: string | null
  expected_close_date: string | null
}

/**
 * Create a deal. userId/accountId are derived from the caller — the old client
 * getSession() lookup is gone. Status defaults to 'open'.
 */
export async function createDeal(
  input: DealInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.insert(deals).values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      title: input.title,
      value: String(input.value),
      currency: input.currency,
      contactId: input.contact_id,
      pipelineId: input.pipeline_id,
      stageId: input.stage_id,
      assignedTo: input.assigned_to,
      notes: input.notes,
      expectedCloseDate: input.expected_close_date,
      status: 'open',
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to create deal' }
  }
}

/** Patch a deal the caller owns. Accepts a partial snake_case patch. */
export async function updateDeal(
  id: string,
  patch: Partial<DealInput> & { status?: string },
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const set: Record<string, unknown> = {}
    if (patch.title !== undefined) set.title = patch.title
    if (patch.value !== undefined) set.value = String(patch.value)
    if (patch.currency !== undefined) set.currency = patch.currency
    if (patch.contact_id !== undefined) set.contactId = patch.contact_id
    if (patch.pipeline_id !== undefined) set.pipelineId = patch.pipeline_id
    if (patch.stage_id !== undefined) set.stageId = patch.stage_id
    if (patch.assigned_to !== undefined) set.assignedTo = patch.assigned_to
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.expected_close_date !== undefined) set.expectedCloseDate = patch.expected_close_date
    if (patch.status !== undefined) set.status = patch.status

    await db
      .update(deals)
      .set(set)
      .where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update deal' }
  }
}

/** Delete a deal the caller owns. */
export async function deleteDeal(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.delete(deals).where(and(eq(deals.id, id), eq(deals.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete deal' }
  }
}

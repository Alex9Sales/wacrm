'use server'

// ============================================================
// Server actions for the Broadcasts pages (list / new / detail).
// Replaces the Supabase browser-client queries these client pages
// used pre-Drizzle. Every query is scoped to the caller's account —
// there is no RLS anymore.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'
import { db, broadcasts, broadcastRecipients, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Broadcast, BroadcastRecipient, Contact } from '@/types'

// Snake_case projection matching the old PostgREST `select('*')` shape.
const broadcastColumns = {
  id: broadcasts.id,
  user_id: broadcasts.userId,
  account_id: broadcasts.accountId,
  name: broadcasts.name,
  template_name: broadcasts.templateName,
  template_language: broadcasts.templateLanguage,
  template_variables: broadcasts.templateVariables,
  audience_filter: broadcasts.audienceFilter,
  scheduled_at: broadcasts.scheduledAt,
  status: broadcasts.status,
  total_recipients: broadcasts.totalRecipients,
  sent_count: broadcasts.sentCount,
  delivered_count: broadcasts.deliveredCount,
  read_count: broadcasts.readCount,
  replied_count: broadcasts.repliedCount,
  failed_count: broadcasts.failedCount,
  created_at: broadcasts.createdAt,
  updated_at: broadcasts.updatedAt,
}

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

/** Newest-first list of the account's broadcasts. */
export async function listBroadcasts(): Promise<Broadcast[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(broadcastColumns)
    .from(broadcasts)
    .where(eq(broadcasts.accountId, ctx.accountId))
    .orderBy(desc(broadcasts.createdAt))
  return rows as unknown as Broadcast[]
}

/** One broadcast (account-scoped) or null. */
export async function getBroadcast(broadcastId: string): Promise<Broadcast | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select(broadcastColumns)
      .from(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1),
  )
  return row as unknown as Broadcast | null
}

/**
 * Recipients of a broadcast with the contact embedded, newest first.
 * Mirrors the old `select('*, contact:contacts(*)')` shape.
 */
export async function listBroadcastRecipients(
  broadcastId: string,
): Promise<BroadcastRecipient[]> {
  const ctx = await getCurrentAccount()

  // Scope through the parent broadcast — recipients have no account_id.
  const parent = firstOrNull(
    await db
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!parent) return []

  const rows = await db
    .select({
      id: broadcastRecipients.id,
      broadcast_id: broadcastRecipients.broadcastId,
      contact_id: broadcastRecipients.contactId,
      status: broadcastRecipients.status,
      whatsapp_message_id: broadcastRecipients.whatsappMessageId,
      sent_at: broadcastRecipients.sentAt,
      delivered_at: broadcastRecipients.deliveredAt,
      read_at: broadcastRecipients.readAt,
      replied_at: broadcastRecipients.repliedAt,
      error_message: broadcastRecipients.errorMessage,
      created_at: broadcastRecipients.createdAt,
      contact: contactColumns,
    })
    .from(broadcastRecipients)
    .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
    .orderBy(desc(broadcastRecipients.createdAt))

  return rows.map((r) => ({
    ...r,
    contact: r.contact?.id ? (r.contact as unknown as Contact) : undefined,
  })) as unknown as BroadcastRecipient[]
}

/** Delete a broadcast (recipients cascade). Returns an error message or null. */
export async function deleteBroadcast(
  broadcastId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(broadcasts)
      .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete broadcast' }
  }
}

export interface SaveDraftInput {
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, unknown>
  audience_filter: Record<string, unknown>
}

/** Persist a draft broadcast row — no recipients, no sending. */
export async function saveDraftBroadcast(
  input: SaveDraftInput,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db.insert(broadcasts).values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      name: input.name,
      templateName: input.template_name,
      templateLanguage: input.template_language,
      templateVariables: input.template_variables,
      audienceFilter: input.audience_filter,
      status: 'draft',
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to save draft' }
  }
}

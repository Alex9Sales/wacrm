'use server'

// ============================================================
// Server actions for the Broadcasts pages (list / new / detail).
// Replaces the Supabase browser-client queries these client pages
// used pre-Drizzle. Every query is scoped to the caller's account —
// there is no RLS anymore.
// ============================================================

import { and, count, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm'
import {
  db,
  broadcasts,
  broadcastRecipients,
  contacts,
  contactTags,
  customFields,
  contactCustomValues,
  messageTemplates,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { channels } from '@/db'
import {
  pauseBroadcast,
  resumeBroadcast,
  cancelBroadcast,
  type ControlResult,
} from '@/lib/queue/broadcast-controls'
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import type { ProviderId } from '@/lib/channels/provider'
import { rescheduleRecipient } from '@/lib/queue/queues'
import {
  normalizePacing,
  pacingIntervalMinutes,
  type PacingConfig,
} from '@/lib/whatsapp/drip-schedule'
import { enqueueTextBroadcast } from '@/lib/broadcasts/text-broadcast'
import type {
  Broadcast,
  BroadcastRecipient,
  Contact,
  CustomField,
  MessageTemplate,
} from '@/types'

// Snake_case projection matching the old PostgREST `select('*')` shape.
const broadcastColumns = {
  id: broadcasts.id,
  user_id: broadcasts.userId,
  account_id: broadcasts.accountId,
  name: broadcasts.name,
  template_name: broadcasts.templateName,
  template_language: broadcasts.templateLanguage,
  template_variables: broadcasts.templateVariables,
  message_kind: broadcasts.messageKind,
  pacing: broadcasts.pacing,
  audience_filter: broadcasts.audienceFilter,
  channel_id: broadcasts.channelId,
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

// ============================================================
// Broadcast wizard support actions (step1-4 + send hook).
// These replace the browser-supabase reads the wizard used
// pre-Drizzle. Every query is scoped to the caller's account.
// ============================================================

/**
 * APPROVED templates only, newest first. Backs the step-1 template
 * picker, which previously read `message_templates` directly with a
 * `status = 'APPROVED'` filter. Only APPROVED templates can be sent via
 * Meta — anything else 400s at broadcast time.
 */
export async function listApprovedTemplates(): Promise<MessageTemplate[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: messageTemplates.id,
      user_id: messageTemplates.userId,
      account_id: messageTemplates.accountId,
      name: messageTemplates.name,
      category: messageTemplates.category,
      language: messageTemplates.language,
      header_type: messageTemplates.headerType,
      header_content: messageTemplates.headerContent,
      header_handle: messageTemplates.headerHandle,
      header_media_url: messageTemplates.headerMediaUrl,
      body_text: messageTemplates.bodyText,
      footer_text: messageTemplates.footerText,
      buttons: messageTemplates.buttons,
      sample_values: messageTemplates.sampleValues,
      status: messageTemplates.status,
      meta_template_id: messageTemplates.metaTemplateId,
      rejection_reason: messageTemplates.rejectionReason,
      quality_score: messageTemplates.qualityScore,
      submission_error: messageTemplates.submissionError,
      last_submitted_at: messageTemplates.lastSubmittedAt,
      created_at: messageTemplates.createdAt,
    })
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.accountId, ctx.accountId),
        eq(messageTemplates.status, 'APPROVED'),
      ),
    )
    .orderBy(desc(messageTemplates.createdAt))
  return rows as unknown as MessageTemplate[]
}

export interface BroadcastChannel {
  id: string
  name: string
  phone_number: string | null
  status: string
}

/**
 * The account's Meta (WhatsApp Cloud) channels — the only providers a
 * template broadcast can go out on. Backs the step-4 channel picker. When
 * the account has exactly one, the wizard defaults it silently; with more
 * than one the user must pick which number to send from.
 */
export async function listMetaChannels(): Promise<BroadcastChannel[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      phone_number: channels.phoneNumber,
      status: channels.status,
    })
    .from(channels)
    .where(
      and(eq(channels.accountId, ctx.accountId), eq(channels.provider, 'meta')),
    )
    .orderBy(channels.name)
  return rows as BroadcastChannel[]
}

/** The account's custom fields, ordered by name (step-2 / step-3). */
export async function listCustomFields(): Promise<CustomField[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: customFields.id,
      user_id: customFields.userId,
      account_id: customFields.accountId,
      field_name: customFields.fieldName,
      field_type: customFields.fieldType,
      field_options: customFields.fieldOptions,
      created_at: customFields.createdAt,
    })
    .from(customFields)
    .where(eq(customFields.accountId, ctx.accountId))
    .orderBy(customFields.fieldName)
  return rows as unknown as CustomField[]
}

export type AudienceCountType = 'all' | 'tags' | 'custom_field' | 'csv' | 'contacts'
export type CustomFieldOperator = 'is' | 'is_not' | 'contains'

export interface AudienceCountInput {
  type: AudienceCountType
  tagIds?: string[]
  customField?: {
    fieldId: string
    operator: CustomFieldOperator
    value: string
  }
  /** For CSV the caller already knows the count — passed through as-is. */
  csvCount?: number
  /** Explicitly picked contact ids (type 'contacts'). */
  contactIds?: string[]
  excludeTagIds?: string[]
}

/**
 * Live recipient-count estimate for the audience wizard (step-2 summary
 * and step-4 review). Mirrors the old browser logic: resolve the base
 * contact-id set for the audience type, subtract any exclude-tag
 * contacts, and count. All account-scoped.
 *
 * Returns null for partially-configured audiences (e.g. a tag filter
 * with no tags picked) so the UI can show "Select an audience type".
 */
export async function estimateAudienceCount(
  input: AudienceCountInput,
): Promise<number | null> {
  const ctx = await getCurrentAccount()

  // Resolve the set of contacts carrying any exclude tag, scoped to the
  // account. Shared across the branches below.
  async function resolveExcludeIds(): Promise<Set<string>> {
    if (!input.excludeTagIds || input.excludeTagIds.length === 0)
      return new Set()
    const rows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.excludeTagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    return new Set(rows.map((r) => r.contact_id))
  }

  if (input.type === 'csv') {
    return input.csvCount ?? 0
  }

  if (input.type === 'contacts') {
    return input.contactIds?.length ?? 0
  }

  if (input.type === 'all') {
    const excludeSet = await resolveExcludeIds()
    const total = firstOrThrow(
      await db
        .select({ n: count() })
        .from(contacts)
        .where(eq(contacts.accountId, ctx.accountId)),
    ).n
    return excludeSet.size ? Math.max(0, total - excludeSet.size) : total
  }

  let baseIds: Set<string>
  if (input.type === 'tags') {
    if (!input.tagIds || input.tagIds.length === 0) return null
    const rows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.tagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    baseIds = new Set(rows.map((r) => r.contact_id))
  } else {
    // custom_field
    const cf = input.customField
    if (!cf?.fieldId || !cf.value) return null
    const rows = await db
      .select({ contact_id: contactCustomValues.contactId })
      .from(contactCustomValues)
      .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
      .where(
        and(
          eq(contactCustomValues.customFieldId, cf.fieldId),
          eq(contacts.accountId, ctx.accountId),
          cf.operator === 'is'
            ? eq(contactCustomValues.value, cf.value)
            : cf.operator === 'is_not'
              ? ne(contactCustomValues.value, cf.value)
              : ilike(contactCustomValues.value, `%${cf.value}%`),
        ),
      )
    baseIds = new Set(rows.map((r) => r.contact_id))
  }

  const excludeSet = await resolveExcludeIds()
  let n = 0
  for (const id of baseIds) if (!excludeSet.has(id)) n++
  return n
}

/**
 * A single representative contact (newest) plus its custom-field values,
 * for the step-3 live preview. Returns null contact when the account has
 * no contacts yet (the UI falls back to sample data).
 */
export async function getPreviewContact(): Promise<{
  contact: Contact | null
  customValues: { custom_field_id: string; value: string }[]
}> {
  const ctx = await getCurrentAccount()
  const contact = firstOrNull(
    await db
      .select(contactColumns)
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId))
      .orderBy(desc(contacts.createdAt))
      .limit(1),
  ) as unknown as Contact | null

  if (!contact) return { contact: null, customValues: [] }

  const customValues = await db
    .select({
      custom_field_id: contactCustomValues.customFieldId,
      value: sql<string>`coalesce(${contactCustomValues.value}, '')`,
    })
    .from(contactCustomValues)
    .where(eq(contactCustomValues.contactId, contact.id))

  return { contact, customValues }
}

// ------------------------------------------------------------
// Send-hook data actions (use-broadcast-sending.ts).
// The hook can't touch @/db (pg is Node-only), so audience
// resolution, CSV contact upsert, custom-value preload, and the
// broadcast/recipient row writes all live here. The actual Meta
// send still goes through POST /api/whatsapp/broadcast.
// ------------------------------------------------------------

export interface ResolveAudienceInput {
  type: AudienceCountType
  tagIds?: string[]
  customField?: {
    fieldId: string
    operator: CustomFieldOperator
    value: string
  }
  csvContacts?: { phone: string; name?: string }[]
  /** Explicitly picked contact ids (type 'contacts'). */
  contactIds?: string[]
  excludeTagIds?: string[]
}

/**
 * Resolve the full contact list for an audience config, applying the
 * exclude-tag subtraction. CSV audiences upsert missing contacts first
 * so every returned contact has a real contacts.id (recipients FK it).
 * Account-scoped throughout.
 */
export async function resolveAudienceContacts(
  input: ResolveAudienceInput,
): Promise<Contact[]> {
  const ctx = await getCurrentAccount()

  let rows: Contact[] = []

  if (input.type === 'all') {
    rows = (await db
      .select(contactColumns)
      .from(contacts)
      .where(eq(contacts.accountId, ctx.accountId))) as unknown as Contact[]
  } else if (input.type === 'tags' && input.tagIds && input.tagIds.length > 0) {
    const idRows = await db
      .selectDistinct({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.tagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    const ids = idRows.map((r) => r.contact_id)
    if (ids.length > 0) {
      rows = (await db
        .select(contactColumns)
        .from(contacts)
        .where(
          and(inArray(contacts.id, ids), eq(contacts.accountId, ctx.accountId)),
        )) as unknown as Contact[]
    }
  } else if (input.type === 'custom_field' && input.customField) {
    const cf = input.customField
    const matchRows = await db
      .selectDistinct({ contact_id: contactCustomValues.contactId })
      .from(contactCustomValues)
      .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
      .where(
        and(
          eq(contactCustomValues.customFieldId, cf.fieldId),
          eq(contacts.accountId, ctx.accountId),
          cf.operator === 'is'
            ? eq(contactCustomValues.value, cf.value)
            : cf.operator === 'is_not'
              ? ne(contactCustomValues.value, cf.value)
              : ilike(contactCustomValues.value, `%${cf.value}%`),
        ),
      )
    const ids = matchRows.map((r) => r.contact_id)
    if (ids.length > 0) {
      rows = (await db
        .select(contactColumns)
        .from(contacts)
        .where(
          and(inArray(contacts.id, ids), eq(contacts.accountId, ctx.accountId)),
        )) as unknown as Contact[]
    }
  } else if (input.type === 'csv' && input.csvContacts) {
    rows = await upsertCsvContacts(ctx.userId, ctx.accountId, input.csvContacts)
  } else if (
    input.type === 'contacts' &&
    input.contactIds &&
    input.contactIds.length > 0
  ) {
    rows = (await db
      .select(contactColumns)
      .from(contacts)
      .where(
        and(
          inArray(contacts.id, input.contactIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )) as unknown as Contact[]
  }

  // Exclude tags — works across every contact-derived audience type.
  // CSV contacts are real rows now, so exclusion applies to them too.
  if (input.excludeTagIds && input.excludeTagIds.length > 0 && rows.length > 0) {
    const exRows = await db
      .select({ contact_id: contactTags.contactId })
      .from(contactTags)
      .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
      .where(
        and(
          inArray(contactTags.tagId, input.excludeTagIds),
          eq(contacts.accountId, ctx.accountId),
        ),
      )
    const excluded = new Set(exRows.map((r) => r.contact_id))
    rows = rows.filter((c) => !excluded.has(c.id))
  }

  return rows
}

/**
 * CSV uploads arrive as raw phone/name pairs. Look up each phone in the
 * account's contacts; insert any that don't exist; return the resolved
 * set in input order. Account/user-scoped — no session lookup needed
 * since the caller is derived via getCurrentAccount().
 */
async function upsertCsvContacts(
  userId: string,
  accountId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) return []

  // De-duplicate by phone within the CSV (users can paste duplicates).
  const uniqueByPhone = new Map<string, { phone: string; name?: string }>()
  for (const row of csvRows) {
    if (row.phone) uniqueByPhone.set(row.phone, row)
  }
  const phones = [...uniqueByPhone.keys()]
  if (phones.length === 0) return []

  const existing = (await db
    .select(contactColumns)
    .from(contacts)
    .where(
      and(eq(contacts.accountId, accountId), inArray(contacts.phone, phones)),
    )) as unknown as Contact[]

  const byPhone = new Map<string, Contact>()
  for (const c of existing) if (c.phone) byPhone.set(c.phone, c)

  const missing = phones
    .filter((p) => !byPhone.has(p))
    .map((phone) => ({
      userId,
      accountId,
      phone,
      name: uniqueByPhone.get(phone)?.name ?? null,
    }))

  if (missing.length > 0) {
    const inserted = (await db
      .insert(contacts)
      .values(missing)
      .returning(contactColumns)) as unknown as Contact[]
    for (const c of inserted) if (c.phone) byPhone.set(c.phone, c)
  }

  // Preserve input order so analytics roughly matches the CSV.
  return phones
    .map((p) => byPhone.get(p))
    .filter((c): c is Contact => Boolean(c))
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns flat
 * rows the hook indexes into contactId → fieldId → value to avoid N+1
 * during the send loop. Scoped to the account through the contacts join.
 */
export async function listContactCustomValues(
  contactIds: string[],
): Promise<{ contact_id: string; custom_field_id: string; value: string }[]> {
  if (contactIds.length === 0) return []
  const ctx = await getCurrentAccount()
  return db
    .select({
      contact_id: contactCustomValues.contactId,
      custom_field_id: contactCustomValues.customFieldId,
      value: sql<string>`coalesce(${contactCustomValues.value}, '')`,
    })
    .from(contactCustomValues)
    .innerJoin(contacts, eq(contactCustomValues.contactId, contacts.id))
    .where(
      and(
        inArray(contactCustomValues.contactId, contactIds),
        eq(contacts.accountId, ctx.accountId),
      ),
    )
}

export interface CreateBroadcastInput {
  name: string
  template_name: string
  template_language: string
  template_variables: Record<string, unknown>
  audience_filter: Record<string, unknown>
  /** Resolved contact ids, in send order. */
  contactIds: string[]
}

/**
 * Create the `broadcasts` row (status 'sending') plus one
 * `broadcast_recipients` row per contact. Returns the new broadcast id.
 * Account-scoped; the recipient FK inherits scoping through the
 * broadcast. Replaces the browser-side inserts the hook used to do.
 */
export async function createBroadcastWithRecipients(
  input: CreateBroadcastInput,
): Promise<{ broadcastId: string | null; error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (input.contactIds.length === 0) {
      return { broadcastId: null, error: 'No contacts found for this audience.' }
    }

    const broadcast = firstOrThrow(
      await db
        .insert(broadcasts)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name: input.name,
          templateName: input.template_name,
          templateLanguage: input.template_language,
          templateVariables: input.template_variables,
          audienceFilter: input.audience_filter,
          status: 'sending',
          totalRecipients: input.contactIds.length,
          sentCount: 0,
          deliveredCount: 0,
          readCount: 0,
          repliedCount: 0,
          failedCount: 0,
        })
        .returning({ id: broadcasts.id }),
    )

    const recipientRows = input.contactIds.map((contactId) => ({
      broadcastId: broadcast.id,
      contactId,
      status: 'pending' as const,
    }))

    const INSERT_BATCH_SIZE = 200
    try {
      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        await db
          .insert(broadcastRecipients)
          .values(recipientRows.slice(i, i + INSERT_BATCH_SIZE))
      }
    } catch (recipErr) {
      // Partial recipient set would desync webhook status updates and
      // aggregate counts — flip to failed and surface the error.
      await db
        .update(broadcasts)
        .set({ status: 'failed', failedCount: input.contactIds.length })
        .where(eq(broadcasts.id, broadcast.id))
      throw recipErr
    }

    return { broadcastId: broadcast.id, error: null }
  } catch (err) {
    return {
      broadcastId: null,
      error: err instanceof Error ? err.message : 'Failed to create broadcast',
    }
  }
}

/**
 * Recipient rows (id + contact_id + phone) for a broadcast, so the hook
 * can build the per-recipient send payload and update statuses by id.
 * Account-scoped through the parent broadcast.
 */
export async function listSendableRecipients(
  broadcastId: string,
): Promise<{ id: string; contact_id: string | null; phone: string | null }[]> {
  const ctx = await getCurrentAccount()
  const parent = firstOrNull(
    await db
      .select({ id: broadcasts.id })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, ctx.accountId),
        ),
      )
      .limit(1),
  )
  if (!parent) return []

  return db
    .select({
      id: broadcastRecipients.id,
      contact_id: broadcastRecipients.contactId,
      phone: contacts.phone,
    })
    .from(broadcastRecipients)
    .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
    .where(eq(broadcastRecipients.broadcastId, broadcastId))
}

export interface RecipientStatusUpdate {
  id: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string | null
  error_message?: string | null
}

/**
 * Apply a batch of per-recipient status updates after a send batch.
 * Aggregate broadcast counts are maintained by a DB trigger, so we only
 * touch the recipient rows here. Account-scoped through the broadcast.
 */
export async function updateRecipientStatuses(
  broadcastId: string,
  updates: RecipientStatusUpdate[],
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const parent = firstOrNull(
      await db
        .select({ id: broadcasts.id })
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.id, broadcastId),
            eq(broadcasts.accountId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (!parent) return { error: 'Broadcast not found' }

    for (const u of updates) {
      if (u.status === 'sent') {
        await db
          .update(broadcastRecipients)
          .set({
            status: 'sent',
            sentAt: new Date().toISOString(),
            whatsappMessageId: u.whatsapp_message_id ?? null,
            errorMessage: null,
          })
          .where(
            and(
              eq(broadcastRecipients.id, u.id),
              eq(broadcastRecipients.broadcastId, broadcastId),
            ),
          )
      } else {
        await db
          .update(broadcastRecipients)
          .set({
            status: 'failed',
            errorMessage: u.error_message ?? 'Unknown error',
          })
          .where(
            and(
              eq(broadcastRecipients.id, u.id),
              eq(broadcastRecipients.broadcastId, broadcastId),
            ),
          )
      }
    }
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to update recipients',
    }
  }
}

// ============================================================
// Humanized text broadcast (RecebAI-style drip) — non-official channels.
// A free-text message trickled out to an audience: at most `dailyCap` per
// day, spread across business hours (08–18h, Mon–Sat, Campo Grande), one
// every window/dailyCap minutes. Server-side (BullMQ), so it survives
// browser close and spans days. Distinct from the template wizard.
// ============================================================

/** Non-official channels (WAHA/Evolution/EvoGo) — the only ones a free-text
 *  drip can go out on (Meta requires an approved template for cold sends). */
export async function listTextBroadcastChannels(): Promise<BroadcastChannel[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      phone_number: channels.phoneNumber,
      status: channels.status,
      provider: channels.provider,
    })
    .from(channels)
    .where(eq(channels.accountId, ctx.accountId))
    .orderBy(channels.name)
  // Only providers that need jitter (non-official) support free-text drips.
  return rows
    .filter((r) => getProvider(r.provider as ProviderId).capabilities.needsJitter)
    .map(({ provider: _p, ...r }) => r as BroadcastChannel)
}

export interface CreateTextBroadcastInput {
  name?: string | null
  channelId: string
  bodyText: string
  /** Optional media attachment (public URL + kind + filename). */
  mediaUrl?: string | null
  mediaType?: 'image' | 'video' | 'document' | 'audio' | null
  mediaFilename?: string | null
  /** Max sends per day (default 50). Window/days/timezone use the defaults. */
  dailyCap?: number
  /** Send starting now (no business-hours wait) instead of the humanized
   *  drip. Useful for tests and urgent sends. */
  sendNow?: boolean
  /** When sendNow: minutes between each message (0 = all at once). */
  sendNowIntervalMin?: number
  audience: ResolveAudienceInput
}

/**
 * Create + launch a humanized text drip. Resolves the audience, computes a
 * send slot per recipient, persists the broadcast + recipient rows, and
 * enqueues the dispatch (which schedules each recipient at its slot).
 */
export async function createTextBroadcast(
  input: CreateTextBroadcastInput,
): Promise<{ broadcastId: string | null; totalRecipients: number; error: string | null }> {
  try {
    const ctx = await requireRole('agent')
    // Resolve the audience (session-scoped) → account-owned contact ids, then
    // hand off to the shared core (validation / slots / persist / enqueue).
    const contactsList = await resolveAudienceContacts(input.audience)
    const recipientContactIds = contactsList
      .map((c) => c.id)
      .filter((id): id is string => !!id)
    return enqueueTextBroadcast(ctx.accountId, ctx.userId, {
      name: input.name,
      channelId: input.channelId,
      bodyText: input.bodyText,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
      mediaFilename: input.mediaFilename,
      dailyCap: input.dailyCap,
      sendNow: input.sendNow,
      sendNowIntervalMin: input.sendNowIntervalMin,
      recipientContactIds,
      audienceFilter: input.audience,
    })
  } catch (err) {
    console.error('[broadcast] createTextBroadcast failed:', err)
    return {
      broadcastId: null,
      totalRecipients: 0,
      error: err instanceof Error ? err.message : 'Falha ao criar o disparo.',
    }
  }
}

/**
 * "Enviar agora" on a humanized text drip: flip it to a burst (null pacing)
 * and promote all its pending recipients so they fire immediately instead
 * of waiting for their business-hours slots. No-op-ish for non-paced
 * broadcasts. Account-scoped.
 */
export async function sendBroadcastNowAction(
  broadcastId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = await requireRole('agent')
    const b = firstOrNull(
      await db
        .select({
          id: broadcasts.id,
          accountId: broadcasts.accountId,
          channelId: broadcasts.channelId,
          status: broadcasts.status,
          pacing: broadcasts.pacing,
        })
        .from(broadcasts)
        .where(
          and(eq(broadcasts.id, broadcastId), eq(broadcasts.accountId, ctx.accountId)),
        )
        .limit(1),
    )
    if (!b) return { ok: false, error: 'Disparo não encontrado.' }
    if (!b.pacing) return { ok: false, error: 'Este disparo já está enviando agora.' }
    if (!['sending', 'scheduled', 'paused'].includes(b.status)) {
      return { ok: false, error: 'O disparo já foi finalizado.' }
    }

    // Keep the SAME spacing the drip used (window ÷ máx/dia), but start now
    // and drop the business-hours gate (null pacing skips the worker guard).
    const cfg = normalizePacing(b.pacing as Partial<PacingConfig>)
    const intervalMs = pacingIntervalMinutes(cfg) * 60_000

    await db
      .update(broadcasts)
      .set({ pacing: null, status: 'sending', updatedAt: new Date().toISOString() })
      .where(eq(broadcasts.id, b.id))

    const channel = b.channelId
      ? await loadChannel(b.channelId)
      : await loadDefaultChannel(b.accountId)
    if (!channel) return { ok: false, error: 'Canal do disparo não encontrado.' }

    // Pending recipients in their originally-scheduled order, re-anchored to
    // now + i·interval.
    const pending = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .where(
        and(
          eq(broadcastRecipients.broadcastId, b.id),
          eq(broadcastRecipients.status, 'pending'),
        ),
      )
      .orderBy(broadcastRecipients.scheduledSlotAt)

    const now = Date.now()
    for (let i = 0; i < pending.length; i++) {
      const delayMs = i * intervalMs
      await db
        .update(broadcastRecipients)
        .set({ scheduledSlotAt: new Date(now + delayMs).toISOString() })
        .where(eq(broadcastRecipients.id, pending[i].id))
      await rescheduleRecipient(channel.id, b.id, pending[i].id, delayMs)
    }
    return { ok: true }
  } catch (err) {
    console.error('[broadcast] sendBroadcastNowAction failed:', err)
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao enviar agora.',
    }
  }
}

// ------------------------------------------------------------
// Broadcast lifecycle controls (Phase 5 UI): pause / resume / cancel.
// The detail page drives these; each resolves the caller's account via
// getCurrentAccount() then delegates to the Next-independent state machine
// in @/lib/queue/broadcast-controls. Returns the ControlResult so the UI
// can surface an invalid-transition message and refetch.
// ------------------------------------------------------------

export async function pauseBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  const ctx = await getCurrentAccount()
  return pauseBroadcast(broadcastId, ctx.accountId)
}

export async function resumeBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  const ctx = await getCurrentAccount()
  return resumeBroadcast(broadcastId, ctx.accountId)
}

export async function cancelBroadcastAction(
  broadcastId: string,
): Promise<ControlResult> {
  const ctx = await getCurrentAccount()
  return cancelBroadcast(broadcastId, ctx.accountId)
}

/** Flip a broadcast's final status once the send loop completes. */
export async function finalizeBroadcastStatus(
  broadcastId: string,
  status: 'sent' | 'failed',
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .update(broadcasts)
      .set({ status })
      .where(
        and(
          eq(broadcasts.id, broadcastId),
          eq(broadcasts.accountId, ctx.accountId),
        ),
      )
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to finalize broadcast',
    }
  }
}

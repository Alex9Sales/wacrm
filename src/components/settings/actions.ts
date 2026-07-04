'use server'

// ============================================================
// Server actions for the settings client components. Replaces the
// Supabase browser-client queries those components used pre-Drizzle.
//
// Every query is scoped to the caller's account via
// getCurrentAccount() — there is no RLS anymore, so the account
// filter is mandatory on every read and write. Response shapes are
// kept snake_case, identical to what the components already expect.
// ============================================================

import { and, count, eq } from 'drizzle-orm'

import {
  db,
  tags,
  messageTemplates,
  channels,
  customFields,
  organization,
  user,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import type { Tag, MessageTemplate, WhatsAppConfig } from '@/types'

// ------------------------------------------------------------
// Tags (tag-manager.tsx)
// ------------------------------------------------------------

const tagColumns = {
  id: tags.id,
  user_id: tags.userId,
  account_id: tags.accountId,
  name: tags.name,
  color: tags.color,
  created_at: tags.createdAt,
}

/** All of the account's tags, oldest first. */
export async function listTags(): Promise<Tag[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(tagColumns)
    .from(tags)
    .where(eq(tags.accountId, ctx.accountId))
    .orderBy(tags.createdAt)
  return rows as unknown as Tag[]
}

/** Create a tag scoped to the caller's account. */
export async function createTag(input: {
  name: string
  color: string
}): Promise<Tag> {
  const ctx = await getCurrentAccount()
  const row = firstOrThrow(
    await db
      .insert(tags)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: input.name,
        color: input.color,
      })
      .returning(tagColumns),
  )
  return row as unknown as Tag
}

/** Delete one of the account's tags. Account-scoped so a member
 *  can only delete tags that belong to their own account. */
export async function deleteTag(id: string): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .delete(tags)
    .where(and(eq(tags.id, id), eq(tags.accountId, ctx.accountId)))
}

// ------------------------------------------------------------
// Message templates (template-manager.tsx)
//
// Only the initial list read moves to a server action — create /
// edit / sync / delete all already flow through the
// /api/whatsapp/templates/* routes.
// ------------------------------------------------------------

/** The account's message templates, newest first. */
export async function listTemplates(): Promise<MessageTemplate[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: messageTemplates.id,
      user_id: messageTemplates.userId,
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
    .where(eq(messageTemplates.accountId, ctx.accountId))
    .orderBy(messageTemplates.createdAt)
  // createdAt asc from the query, reverse to newest-first to match the
  // old `.order('created_at', { ascending: false })`.
  rows.reverse()
  return rows as unknown as MessageTemplate[]
}

// ------------------------------------------------------------
// Overview counts (settings-overview.tsx)
//
// Replaces four `select('id', { count: 'exact', head: true })`
// browser queries with one server round-trip. All account-scoped.
// (Members and pending-invite counts still come from their existing
// /api/account/* routes in the component.)
// ------------------------------------------------------------

export interface OverviewCountsResult {
  templates: number
  templatesPending: number
  tags: number
  customFields: number
}

export async function getOverviewCounts(): Promise<OverviewCountsResult> {
  const ctx = await getCurrentAccount()

  const [templatesRow, templatesPendingRow, tagsRow, fieldsRow] =
    await Promise.all([
      db
        .select({ n: count() })
        .from(messageTemplates)
        .where(eq(messageTemplates.accountId, ctx.accountId)),
      db
        .select({ n: count() })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.accountId, ctx.accountId),
            eq(messageTemplates.status, 'PENDING'),
          ),
        ),
      db
        .select({ n: count() })
        .from(tags)
        .where(eq(tags.accountId, ctx.accountId)),
      db
        .select({ n: count() })
        .from(customFields)
        .where(eq(customFields.accountId, ctx.accountId)),
    ])

  return {
    templates: templatesRow[0]?.n ?? 0,
    templatesPending: templatesPendingRow[0]?.n ?? 0,
    tags: tagsRow[0]?.n ?? 0,
    customFields: fieldsRow[0]?.n ?? 0,
  }
}

// ------------------------------------------------------------
// WhatsApp config row (whatsapp-config.tsx, settings-overview.tsx)
//
// The GET /api/whatsapp/config route decrypts the token and pings
// Meta for a *health* signal; it doesn't return the stored row the
// form needs to hydrate. This read returns the non-secret columns
// only — the access/verify tokens never leave the server.
// ------------------------------------------------------------

export type WhatsAppConfigRow = Pick<
  WhatsAppConfig,
  | 'id'
  | 'phone_number_id'
  | 'waba_id'
  | 'status'
  | 'connected_at'
  | 'registered_at'
  | 'subscribed_apps_at'
  | 'last_registration_error'
>

/** The account's WhatsApp config row (secrets omitted), or null.
 *  Backed by the account's Meta channel (Phase 4). Non-secret routing
 *  info lives on `provider_meta`; the registration-progress timestamps
 *  that the legacy whatsapp_config carried have no channel equivalent
 *  yet, so they surface as null. */
export async function getWhatsAppConfig(): Promise<WhatsAppConfigRow | null> {
  const ctx = await getCurrentAccount()
  const row = firstOrNull(
    await db
      .select({
        id: channels.id,
        status: channels.status,
        providerMeta: channels.providerMeta,
      })
      .from(channels)
      .where(
        and(
          eq(channels.accountId, ctx.accountId),
          eq(channels.provider, 'meta'),
        ),
      )
      .limit(1),
  )
  if (!row) return null

  const meta = (row.providerMeta ?? {}) as Record<string, unknown>
  return {
    id: row.id,
    phone_number_id: (meta.phone_number_id as string | undefined) ?? '',
    waba_id: (meta.waba_id as string | undefined) ?? undefined,
    status: row.status === 'connected' ? 'connected' : 'disconnected',
    connected_at: (meta.connected_at as string | undefined) ?? undefined,
    registered_at: (meta.registered_at as string | undefined) ?? undefined,
    subscribed_apps_at:
      (meta.subscribed_apps_at as string | undefined) ?? undefined,
    last_registration_error:
      (meta.last_registration_error as string | undefined) ?? undefined,
  } as WhatsAppConfigRow
}

// ------------------------------------------------------------
// Deals settings — account default currency (deals-settings.tsx)
// ------------------------------------------------------------

/** Update the account's default currency. Admin+ only (mirrors the
 *  old `accounts_update` RLS policy). */
export async function setDefaultCurrency(currency: string): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .update(organization)
    .set({ default_currency: currency })
    .where(eq(organization.id, ctx.accountId))
}

// ------------------------------------------------------------
// Profile (profile-form.tsx)
//
// The avatar lives on `user.image` (Better Auth). The file itself is
// uploaded to MinIO by the client via POST /api/media/upload; this
// action persists the resulting public URL (or clears it on removal).
// ------------------------------------------------------------

/** Update the current user's display name on their user row. */
export async function updateProfileName(fullName: string): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(user)
    .set({ name: fullName })
    .where(eq(user.id, ctx.userId))
}

/**
 * Persist the current user's avatar URL (`user.image`). Pass a public
 * URL returned by the media upload route, or `null` to remove the
 * avatar. Account-scoped auth via getCurrentAccount().
 */
export async function updateProfileAvatar(
  imageUrl: string | null,
): Promise<void> {
  const ctx = await getCurrentAccount()
  await db
    .update(user)
    .set({ image: imageUrl })
    .where(eq(user.id, ctx.userId))
}

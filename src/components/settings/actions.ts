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

import { and, asc, count, eq, inArray } from 'drizzle-orm'

import {
  db,
  tags,
  messageTemplates,
  channels,
  customFields,
  cadences,
  leadDistribution,
  organization,
  user,
  member,
  account,
  sectors,
  sectorMembers,
  conversations,
  quickReplies,
  aiCompanyProfile,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { auth } from '@/lib/auth'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { loadLeadDistribution } from '@/lib/leads/distribution'
import {
  getAccountSettings,
  updateAccountSettings,
} from '@/lib/settings/account-settings'
import { previewDigest, sendDigestNow } from '@/lib/reports/owner-digest'
import { getCompanyProfile } from '@/lib/ai/company-profile'
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

// ------------------------------------------------------------
// Atendimento — workspace-wide inbox preferences (service-panel.tsx)
// ------------------------------------------------------------

/** Master switch: does the CRM ring/receive WhatsApp calls? Any member reads
 *  it (the call modal gates on it); only supervisor+ can change it. */
export async function getCrmCallingEnabled(): Promise<boolean> {
  const ctx = await getCurrentAccount()
  const settings = await getAccountSettings(ctx.accountId)
  return settings.crmCallingEnabled
}

/** Toggle CRM call receiving (admin/supervisor only). Off = no browser rings. */
export async function setCrmCallingEnabled(enabled: boolean): Promise<void> {
  const ctx = await requireRole('supervisor')
  await updateAccountSettings(ctx.accountId, { crmCallingEnabled: enabled })
}

/** Whether outbound agent messages are prefixed with the sender's name. */
export async function getAgentSignatureEnabled(): Promise<boolean> {
  const ctx = await getCurrentAccount()
  const settings = await getAccountSettings(ctx.accountId)
  return settings.agentSignatureEnabled
}

/** Toggle the agent-signature preference (admins only). */
export async function setAgentSignatureEnabled(
  enabled: boolean,
): Promise<void> {
  const ctx = await requireRole('admin')
  await updateAccountSettings(ctx.accountId, { agentSignatureEnabled: enabled })
}

/** Whether inbound audio notes are transcribed to text. */
export async function getAudioTranscriptionEnabled(): Promise<boolean> {
  const ctx = await getCurrentAccount()
  const settings = await getAccountSettings(ctx.accountId)
  return settings.audioTranscriptionEnabled
}

/** Toggle audio transcription (admins only). Uses the account's OpenAI key. */
export async function setAudioTranscriptionEnabled(
  enabled: boolean,
): Promise<void> {
  const ctx = await requireRole('admin')
  await updateAccountSettings(ctx.accountId, {
    audioTranscriptionEnabled: enabled,
  })
}

/** Read the auto-reassign (SLA) config. */
export async function getAutoReassignConfig(): Promise<{
  enabled: boolean
  minutes: number
}> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  return { enabled: s.autoReassignEnabled, minutes: s.autoReassignMinutes }
}

/** Update the auto-reassign (SLA) config (admins only). */
export async function setAutoReassignConfig(
  enabled: boolean,
  minutes: number,
): Promise<void> {
  const ctx = await requireRole('admin')
  const clamped = Math.min(120, Math.max(1, Math.floor(minutes) || 5))
  await updateAccountSettings(ctx.accountId, {
    autoReassignEnabled: enabled,
    autoReassignMinutes: clamped,
  })
}

// ------------------------------------------------------------
// Business hours (horário de atendimento) — service-panel.tsx
// ------------------------------------------------------------

export interface BusinessHoursConfig {
  enabled: boolean
  days: { open: string | null; close: string | null }[]
  timezone: string
  message: string
}

export async function getBusinessHoursConfig(): Promise<BusinessHoursConfig> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  return {
    enabled: s.businessHoursEnabled,
    days: s.businessDays,
    timezone: s.businessTimezone,
    message: s.outOfHoursMessage,
  }
}

/** Update the business-hours config (admins only). */
export async function setBusinessHoursConfig(
  input: BusinessHoursConfig,
): Promise<void> {
  const ctx = await requireRole('admin')
  // Normalize: 7 days, each {open,close} either both "HH:MM" or both null.
  const hhmm = /^\d{1,2}:\d{2}$/
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = input.days?.[i]
    const open = d?.open && hhmm.test(d.open) ? d.open : null
    const close = d?.close && hhmm.test(d.close) ? d.close : null
    return open && close ? { open, close } : { open: null, close: null }
  })
  await updateAccountSettings(ctx.accountId, {
    businessHoursEnabled: input.enabled,
    businessDays: days,
    businessTimezone: input.timezone?.trim() || 'America/Sao_Paulo',
    outOfHoursMessage:
      input.message?.trim() ||
      'Olá! No momento estamos fora do horário de atendimento.',
  })
}

// ------------------------------------------------------------
// CSAT (pesquisa de satisfação) — service-panel.tsx
// ------------------------------------------------------------

export interface CsatConfig {
  enabled: boolean
  question: string
  thanks: string
  commentPrompt: string
}

export async function getCsatConfig(): Promise<CsatConfig> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  return {
    enabled: s.csatEnabled,
    question: s.csatQuestion,
    thanks: s.csatThanks,
    commentPrompt: s.csatCommentPrompt,
  }
}

/** Update the CSAT config (admins only). */
export async function setCsatConfig(input: CsatConfig): Promise<void> {
  const ctx = await requireRole('admin')
  await updateAccountSettings(ctx.accountId, {
    csatEnabled: input.enabled,
    csatQuestion:
      input.question?.trim() ||
      'Como você avalia nosso atendimento? Responda de 1 a 5.',
    csatThanks: input.thanks?.trim() || 'Obrigado pela sua avaliação!',
    csatCommentPrompt:
      input.commentPrompt?.trim() ||
      'Obrigado pela nota! Se quiser, deixe um comentário sobre o atendimento. 🙏',
  })
}

// ------------------------------------------------------------
// Team members — direct create (members-tab.tsx)
// ------------------------------------------------------------

export interface CreateTeamMemberInput {
  name: string
  email: string
  password: string
  role: 'admin' | 'supervisor' | 'agent' | 'viewer'
}

/**
 * Create a team member directly with a login + password (admins only) and
 * add them to THIS account. Mirrors the super-admin client provisioning:
 * `signUpEmail` creates the user (hashed credential, no personal org — org
 * creation lives on the signup page, not a hook), then a `member` row ties
 * them to the current account. The caller hands the credentials over
 * out-of-band (WhatsApp, etc.); the person can change the password later.
 */
export type CreateTeamMemberResult =
  | { ok: true; email: string; reactivated: boolean }
  | { ok: false; error: string }

export async function createTeamMember(
  input: CreateTeamMemberInput,
): Promise<CreateTeamMemberResult> {
  // NOTE: this RETURNS errors instead of throwing them. A server action that
  // throws surfaces on the client (in production) as the generic "An error
  // occurred in the Server Components render" digest — the real message is
  // stripped. Felipe hit exactly that re-adding a deleted agent. Returning the
  // message keeps it visible.
  //
  // Supervisors can create members too, but only up to their own level — a
  // supervisor cannot mint an admin/owner (privilege escalation).
  const ctx = await requireRole('supervisor')
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  const password = input.password
  if (!name || !email || !password) {
    return { ok: false, error: 'Preencha nome, e-mail e senha.' }
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: 'E-mail inválido.' }
  }
  if (password.length < 8) {
    return { ok: false, error: 'A senha precisa ter ao menos 8 caracteres.' }
  }
  let role = (['admin', 'supervisor', 'agent', 'viewer'] as const).includes(
    input.role,
  )
    ? input.role
    : 'agent'
  if ((role === 'admin' || role === 'supervisor') && !hasMinRole(ctx.role, 'admin')) {
    role = 'agent'
  }

  // An existing user with this email may be (a) already a member of THIS
  // account → real conflict; or (b) a leftover from a prior "excluir membro"
  // (removeMember drops the membership but NOT the user/email) → re-attach and
  // reset the password to the one just typed, so re-adding a deleted agent
  // "just works" instead of erroring.
  const existing = firstOrNull(
    await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1),
  )
  if (existing) {
    const alreadyMember = firstOrNull(
      await db
        .select({ id: member.id })
        .from(member)
        .where(
          and(
            eq(member.userId, existing.id),
            eq(member.organizationId, ctx.accountId),
          ),
        )
        .limit(1),
    )
    if (alreadyMember) {
      return { ok: false, error: 'Este e-mail já é membro do time.' }
    }
    try {
      const authCtx = await auth.$context
      const hashed = await authCtx.password.hash(password)
      await db
        .update(user)
        .set({ name, updatedAt: new Date().toISOString() })
        .where(eq(user.id, existing.id))
      const updatedPw = await db
        .update(account)
        .set({ password: hashed, updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(account.userId, existing.id),
            eq(account.providerId, 'credential'),
          ),
        )
        .returning({ id: account.id })
      if (updatedPw.length === 0) {
        // No credential row (e.g. was OAuth-only) — create one.
        await db.insert(account).values({
          userId: existing.id,
          accountId: existing.id,
          providerId: 'credential',
          password: hashed,
        })
      }
      await db.insert(member).values({
        userId: existing.id,
        organizationId: ctx.accountId,
        role,
      })
      return { ok: true, email, reactivated: true }
    } catch (err) {
      console.error('[createTeamMember] re-attach failed:', err)
      return { ok: false, error: 'Não foi possível reativar esse e-mail.' }
    }
  }

  let newUserId: string
  try {
    const res = await auth.api.signUpEmail({ body: { name, email, password } })
    newUserId = res.user.id
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : ''
    if (/exist|taken|unique|duplicate/i.test(message)) {
      return { ok: false, error: 'Já existe um usuário com esse e-mail.' }
    }
    if (/password|weak|short|8|character/i.test(message)) {
      return { ok: false, error: 'Senha muito fraca — use ao menos 8 caracteres.' }
    }
    console.error('[createTeamMember] signUpEmail failed:', err)
    return { ok: false, error: 'Não foi possível criar o membro.' }
  }

  await db.insert(member).values({
    userId: newUserId,
    organizationId: ctx.accountId,
    role,
  })

  return { ok: true, email, reactivated: false }
}

// ------------------------------------------------------------
// Sectors (departments) — routing + privacy (sectors-panel.tsx)
// ------------------------------------------------------------

export interface SectorWithMembers {
  id: string
  name: string
  color: string
  keywords: string[]
  autoAssign: boolean
  memberIds: string[]
}

/** All sectors in the account with their member user ids. */
export async function listSectorsWithMembers(): Promise<SectorWithMembers[]> {
  const ctx = await requireRole('admin')
  const secs = await db
    .select({
      id: sectors.id,
      name: sectors.name,
      color: sectors.color,
      keywords: sectors.keywords,
      autoAssign: sectors.autoAssign,
    })
    .from(sectors)
    .where(eq(sectors.accountId, ctx.accountId))
    .orderBy(asc(sectors.name))
  if (secs.length === 0) return []
  const links = await db
    .select({ sectorId: sectorMembers.sectorId, userId: sectorMembers.userId })
    .from(sectorMembers)
    .where(
      inArray(
        sectorMembers.sectorId,
        secs.map((s) => s.id),
      ),
    )
  const byId = new Map<string, string[]>()
  for (const l of links) {
    const arr = byId.get(l.sectorId) ?? []
    arr.push(l.userId)
    byId.set(l.sectorId, arr)
  }
  return secs.map((s) => ({ ...s, memberIds: byId.get(s.id) ?? [] }))
}

/** Normalize a keyword list: trim, drop empties, dedupe. */
function cleanKeywords(kws?: string[]): string[] {
  if (!kws) return []
  return [
    ...new Set(kws.map((k) => k.trim()).filter((k) => k.length > 0)),
  ]
}

/** Create a sector (admins). */
export async function createSector(input: {
  name: string
  color?: string
  keywords?: string[]
  autoAssign?: boolean
  memberIds?: string[]
}): Promise<{ id: string }> {
  const ctx = await requireRole('admin')
  const name = input.name.trim()
  if (!name) throw new Error('Dê um nome ao setor.')
  const [row] = await db
    .insert(sectors)
    .values({
      accountId: ctx.accountId,
      name,
      color: input.color?.trim() || '#6d4bd8',
      keywords: cleanKeywords(input.keywords),
      autoAssign: input.autoAssign ?? true,
    })
    .returning({ id: sectors.id })
  await replaceSectorMembers(ctx.accountId, row.id, input.memberIds ?? [])
  return { id: row.id }
}

/** Rename / recolor / retune routing of a sector (admins). */
export async function updateSector(
  sectorId: string,
  input: {
    name?: string
    color?: string
    keywords?: string[]
    autoAssign?: boolean
  },
): Promise<void> {
  const ctx = await requireRole('admin')
  const patch: {
    name?: string
    color?: string
    keywords?: string[]
    autoAssign?: boolean
    updatedAt: string
  } = {
    updatedAt: new Date().toISOString(),
  }
  if (input.name !== undefined) {
    const n = input.name.trim()
    if (!n) throw new Error('Dê um nome ao setor.')
    patch.name = n
  }
  if (input.color !== undefined) patch.color = input.color.trim() || '#6d4bd8'
  if (input.keywords !== undefined) patch.keywords = cleanKeywords(input.keywords)
  if (input.autoAssign !== undefined) patch.autoAssign = input.autoAssign
  await db
    .update(sectors)
    .set(patch)
    .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
}

/** A channel + its default routing sector (settings routing UI). */
export interface ChannelRouting {
  id: string
  name: string
  provider: string
  phoneNumber: string | null
  defaultSectorId: string | null
}

/** List the account's channels with their default sector (admins). */
export async function listChannelsForRouting(): Promise<ChannelRouting[]> {
  const ctx = await requireRole('admin')
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      provider: channels.provider,
      phoneNumber: channels.phoneNumber,
      defaultSectorId: channels.defaultSectorId,
    })
    .from(channels)
    .where(eq(channels.accountId, ctx.accountId))
    .orderBy(asc(channels.name))
  return rows
}

/** Set (or clear) a channel's default routing sector (admins). */
export async function setChannelDefaultSector(
  channelId: string,
  sectorId: string | null,
): Promise<void> {
  const ctx = await requireRole('admin')
  // Validate the sector belongs to this account when provided.
  if (sectorId) {
    const s = firstOrNull(
      await db
        .select({ id: sectors.id })
        .from(sectors)
        .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!s) throw new Error('Setor não encontrado.')
  }
  await db
    .update(channels)
    .set({ defaultSectorId: sectorId, updatedAt: new Date().toISOString() })
    .where(and(eq(channels.id, channelId), eq(channels.accountId, ctx.accountId)))
}

/** Replace the members of a sector (admins). */
export async function setSectorMembers(
  sectorId: string,
  userIds: string[],
): Promise<void> {
  const ctx = await requireRole('admin')
  // Verify the sector is in this account.
  const s = firstOrNull(
    await db
      .select({ id: sectors.id })
      .from(sectors)
      .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!s) throw new Error('Setor não encontrado.')
  await replaceSectorMembers(ctx.accountId, sectorId, userIds)
}

/** Delete a sector (admins). Its conversations fall back to the general
 *  queue so they don't become invisible. */
export async function deleteSector(sectorId: string): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .update(conversations)
    .set({ sectorId: null })
    .where(
      and(
        eq(conversations.sectorId, sectorId),
        eq(conversations.accountId, ctx.accountId),
      ),
    )
  await db
    .delete(sectors)
    .where(and(eq(sectors.id, sectorId), eq(sectors.accountId, ctx.accountId)))
}

/** Internal: set a sector's members to exactly `userIds` (account-validated). */
async function replaceSectorMembers(
  accountId: string,
  sectorId: string,
  userIds: string[],
): Promise<void> {
  const memberRows = await db
    .select({ id: user.id })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, accountId))
  const valid = new Set(memberRows.map((r) => r.id))
  const ids = [...new Set(userIds.filter((id) => valid.has(id)))]
  await db.delete(sectorMembers).where(eq(sectorMembers.sectorId, sectorId))
  if (ids.length > 0) {
    await db
      .insert(sectorMembers)
      .values(ids.map((userId) => ({ sectorId, userId })))
      .onConflictDoNothing()
  }
}

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

// ------------------------------------------------------------
// Quick replies (respostas rápidas) — admin CRUD. Reading (for the
// composer) lives in inbox/actions.ts and is open to any member.
// ------------------------------------------------------------

export interface QuickReply {
  id: string
  shortcut: string
  content: string
}

export async function listQuickRepliesAdmin(): Promise<QuickReply[]> {
  const ctx = await requireRole('admin')
  return db
    .select({
      id: quickReplies.id,
      shortcut: quickReplies.shortcut,
      content: quickReplies.content,
    })
    .from(quickReplies)
    .where(eq(quickReplies.accountId, ctx.accountId))
    .orderBy(asc(quickReplies.shortcut))
}

function normalizeShortcut(raw: string): string {
  // Strip a leading "/" and spaces; keep it a single token, lowercased.
  return raw.trim().replace(/^\/+/, '').replace(/\s+/g, '_').toLowerCase()
}

export async function createQuickReply(input: {
  shortcut: string
  content: string
}): Promise<{ id: string }> {
  const ctx = await requireRole('admin')
  const shortcut = normalizeShortcut(input.shortcut)
  const content = input.content.trim()
  if (!shortcut) throw new Error('Dê um atalho à resposta (ex.: preco).')
  if (!content) throw new Error('Escreva o conteúdo da resposta.')
  try {
    const [row] = await db
      .insert(quickReplies)
      .values({ accountId: ctx.accountId, shortcut, content })
      .returning({ id: quickReplies.id })
    return { id: row.id }
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error(`Já existe uma resposta com o atalho "${shortcut}".`)
    }
    throw err
  }
}

export async function updateQuickReply(
  id: string,
  input: { shortcut?: string; content?: string },
): Promise<void> {
  const ctx = await requireRole('admin')
  const patch: { shortcut?: string; content?: string; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  }
  if (input.shortcut !== undefined) {
    const s = normalizeShortcut(input.shortcut)
    if (!s) throw new Error('Dê um atalho à resposta.')
    patch.shortcut = s
  }
  if (input.content !== undefined) {
    const c = input.content.trim()
    if (!c) throw new Error('Escreva o conteúdo da resposta.')
    patch.content = c
  }
  try {
    await db
      .update(quickReplies)
      .set(patch)
      .where(
        and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)),
      )
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new Error('Já existe uma resposta com esse atalho.')
    }
    throw err
  }
}

export async function deleteQuickReply(id: string): Promise<void> {
  const ctx = await requireRole('admin')
  await db
    .delete(quickReplies)
    .where(
      and(eq(quickReplies.id, id), eq(quickReplies.accountId, ctx.accountId)),
    )
}

// ============================================================
// Distribuição automática de leads (rodízio). Migração 0115.
// ============================================================

/** Config atual + membros da conta (pra montar a tela). */
export async function getLeadDistribution() {
  const ctx = await getCurrentAccount()
  const config = await loadLeadDistribution(ctx.accountId)
  const members = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, ctx.accountId))
    .orderBy(asc(user.name))
  return { config, members }
}

/** Salva a config do rodízio (admin+). Upsert por conta. */
export async function saveLeadDistribution(input: {
  enabled: boolean
  strategy: 'round_robin' | 'load'
  memberIds: string[]
}): Promise<{ error: string | null }> {
  const ctx = await requireRole('admin')
  const strategy = input.strategy === 'load' ? 'load' : 'round_robin'
  const ids = Array.from(
    new Set((input.memberIds ?? []).filter((v) => typeof v === 'string')),
  )
  const now = new Date().toISOString()
  await db
    .insert(leadDistribution)
    .values({
      accountId: ctx.accountId,
      enabled: !!input.enabled,
      strategy,
      memberIds: ids,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: leadDistribution.accountId,
      set: { enabled: !!input.enabled, strategy, memberIds: ids, updatedAt: now },
    })
  return { error: null }
}

// ============================================================
// Alerta de negócio "esfriando" (parado na etapa). Guardado no
// account_settings.staleDealDays. 0 = desligado.
// ============================================================

export async function getDealAlertDays(): Promise<number> {
  const ctx = await getCurrentAccount()
  const s = await getAccountSettings(ctx.accountId)
  return typeof s.staleDealDays === 'number' ? s.staleDealDays : 7
}

export async function setDealAlertDays(days: number): Promise<{ error: string | null }> {
  const ctx = await requireRole('admin')
  const n = Math.max(0, Math.min(365, Math.floor(Number(days) || 0)))
  await updateAccountSettings(ctx.accountId, { staleDealDays: n })
  return { error: null }
}

// ============================================================
// Gatilho por status: cadência ao GANHAR / PERDER o negócio.
// ============================================================

export async function getStatusCadences(): Promise<{
  cadences: { id: string; name: string; active: boolean }[]
  wonCadenceId: string | null
  lostCadenceId: string | null
}> {
  const ctx = await getCurrentAccount()
  const [list, s] = await Promise.all([
    db
      .select({ id: cadences.id, name: cadences.name, active: cadences.active })
      .from(cadences)
      .where(eq(cadences.accountId, ctx.accountId))
      .orderBy(asc(cadences.name)),
    getAccountSettings(ctx.accountId),
  ])
  return {
    cadences: list,
    wonCadenceId: s.wonCadenceId ?? null,
    lostCadenceId: s.lostCadenceId ?? null,
  }
}

export async function setStatusCadences(input: {
  wonCadenceId: string | null
  lostCadenceId: string | null
}): Promise<{ error: string | null }> {
  const ctx = await requireRole('admin')
  await updateAccountSettings(ctx.accountId, {
    wonCadenceId: input.wonCadenceId || null,
    lostCadenceId: input.lostCadenceId || null,
  })
  return { error: null }
}

// ============================================================
// Sócio IA — resumo diário do funil no WhatsApp do dono.
// ============================================================

const WA_PROVIDERS = ['waha', 'meta', 'evolution', 'evogo']

export async function getOwnerDigest(): Promise<{
  enabled: boolean
  hour: number
  phone: string
  channelId: string | null
  channels: { id: string; name: string }[]
  preview: string
}> {
  const ctx = await getCurrentAccount()
  const [s, chans, preview] = await Promise.all([
    getAccountSettings(ctx.accountId),
    db
      .select({ id: channels.id, name: channels.name, provider: channels.provider })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId)),
    previewDigest(ctx.accountId).catch(() => ''),
  ])
  return {
    enabled: s.ownerDigestEnabled,
    hour: s.ownerDigestHour,
    phone: s.ownerDigestPhone,
    channelId: s.ownerDigestChannelId,
    channels: chans
      .filter((c) => WA_PROVIDERS.includes(c.provider))
      .map((c) => ({ id: c.id, name: c.name })),
    preview,
  }
}

/** Normaliza o telefone do dono: só dígitos + prefixo BR (55) se vier "pelado". */
function normalizeOwnerPhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (!digits) return ''
  // 10–11 dígitos = DDD + número sem código do país → assume Brasil (+55).
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    return `55${digits}`
  }
  return digits
}

export async function setOwnerDigest(input: {
  enabled: boolean
  hour: number
  phone: string
  channelId: string | null
}): Promise<{ error: string | null }> {
  const ctx = await requireRole('admin')
  const phone = normalizeOwnerPhone(input.phone)
  if (input.enabled && !phone) {
    return { error: 'Informe o número do WhatsApp que vai receber o resumo.' }
  }
  const hour = Math.min(23, Math.max(0, Math.trunc(Number(input.hour))))
  await updateAccountSettings(ctx.accountId, {
    ownerDigestEnabled: !!input.enabled,
    ownerDigestHour: Number.isFinite(hour) ? hour : 8,
    ownerDigestPhone: phone,
    ownerDigestChannelId: input.channelId || null,
  })
  return { error: null }
}

export async function sendOwnerDigestTest(): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireRole('admin')
  return sendDigestNow(ctx.accountId)
}

// ============================================================
// Dados da empresa (emissor das propostas): logo + razão social + nome fantasia
// + CNPJ/CPF + site + descrição + formas de pagamento. Logo em organization.logo;
// o resto em ai_company_profile (compartilhado com o contexto da IA).
// ============================================================

export interface CompanyDataInput {
  logo: string | null
  legalName: string | null
  tradeName: string | null
  document: string | null
  website: string | null
  address: string | null
  description: string | null
  paymentMethods: string | null
}

export async function getCompanyData(): Promise<CompanyDataInput> {
  const ctx = await getCurrentAccount()
  const [profile, orgRow] = await Promise.all([
    getCompanyProfile(ctx.accountId),
    db
      .select({ logo: organization.logo })
      .from(organization)
      .where(eq(organization.id, ctx.accountId))
      .limit(1),
  ])
  return {
    logo: orgRow[0]?.logo ?? null,
    legalName: profile.legal_name,
    // Mostra o nome fantasia; se vazio, cai no business_name que a IA já usa.
    tradeName: profile.trade_name || profile.business_name,
    document: profile.document,
    website: profile.website,
    address: profile.address,
    description: profile.description,
    paymentMethods: profile.payment_methods,
  }
}

/** Busca dados de um CNPJ (BrasilAPI, pública/grátis) — razão social, nome
 *  fantasia e endereço — pra preencher automaticamente os dados da empresa. */
export async function lookupCnpj(cnpj: string): Promise<{
  legalName: string | null
  tradeName: string | null
  address: string | null
  error?: string
}> {
  await getCurrentAccount()
  const digits = (cnpj ?? '').replace(/\D/g, '')
  if (digits.length !== 14) {
    return { legalName: null, tradeName: null, address: null, error: 'CNPJ inválido (precisa ter 14 dígitos).' }
  }
  try {
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`, {
      // BrasilAPI (Cloudflare) devolve 403 "Forbidden" sem User-Agent de browser.
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; FluxiaCRM/1.0)',
      },
      cache: 'no-store',
    })
    if (!res.ok) {
      return {
        legalName: null,
        tradeName: null,
        address: null,
        error: res.status === 404 ? 'CNPJ não encontrado.' : 'Não foi possível consultar o CNPJ agora.',
      }
    }
    const d = (await res.json()) as Record<string, unknown>
    const s = (k: string) => {
      const v = d[k]
      return typeof v === 'string' ? v.trim() : v != null ? String(v) : ''
    }
    const parts = [
      [s('logradouro'), s('numero')].filter(Boolean).join(', '),
      s('bairro'),
      [s('municipio'), s('uf')].filter(Boolean).join('/'),
      s('cep') ? `CEP ${s('cep')}` : '',
    ].filter(Boolean)
    return {
      legalName: s('razao_social') || null,
      tradeName: s('nome_fantasia') || null,
      address: parts.length ? parts.join(' - ') : null,
    }
  } catch {
    return { legalName: null, tradeName: null, address: null, error: 'Não foi possível consultar o CNPJ agora.' }
  }
}

export async function saveCompanyData(
  input: CompanyDataInput,
): Promise<{ error: string | null }> {
  const ctx = await requireRole('admin')
  const clean = (v: string | null | undefined) => (v ?? '').trim() || null
  const now = new Date().toISOString()
  await db
    .insert(aiCompanyProfile)
    .values({
      accountId: ctx.accountId,
      legalName: clean(input.legalName),
      tradeName: clean(input.tradeName),
      document: clean(input.document),
      website: clean(input.website),
      address: clean(input.address),
      description: clean(input.description),
      paymentMethods: clean(input.paymentMethods),
      updatedBy: ctx.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: aiCompanyProfile.accountId,
      set: {
        legalName: clean(input.legalName),
        tradeName: clean(input.tradeName),
        document: clean(input.document),
        website: clean(input.website),
        address: clean(input.address),
        description: clean(input.description),
        paymentMethods: clean(input.paymentMethods),
        updatedBy: ctx.userId,
        updatedAt: now,
      },
    })
  await db
    .update(organization)
    .set({ logo: clean(input.logo) })
    .where(eq(organization.id, ctx.accountId))
  return { error: null }
}

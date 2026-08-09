'use server'

// ============================================================
// Server actions for the Contacts page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Every query is
// scoped to the caller's account — there is no RLS anymore.
// ============================================================

import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import {
  db,
  contacts,
  contactTags,
  tags,
  contactNotes,
  customFields,
  contactCustomValues,
  companies,
  deals,
  pipelineStages,
} from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import { dispatchTagAddedToFlows } from '@/lib/flows/engine'
import {
  sanitizePhoneForMeta,
  isValidE164,
  normalizeInboundPhoneBR,
  phonesMatch,
} from '@/lib/whatsapp/phone-utils'
import {
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  dedupeByPhone,
  last8,
  type ExistingContact,
} from '@/lib/contacts/dedupe'
import {
  resolveImportTagIds,
  assignImportedContactTags,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags'
import type {
  Contact,
  ContactTag,
  Tag,
  ContactNote,
  CustomField,
  ContactCustomValue,
  Deal,
} from '@/types'

const contactColumns = {
  id: contacts.id,
  user_id: contacts.userId,
  account_id: contacts.accountId,
  phone: contacts.phone,
  phone_normalized: contacts.phoneNormalized,
  name: contacts.name,
  email: contacts.email,
  company: contacts.company,
  customer_codes: contacts.customerCodes,
  avatar_url: contacts.avatarUrl,
  created_at: contacts.createdAt,
  updated_at: contacts.updatedAt,
}

/** All of the account's tags. */
export async function listTags(): Promise<Tag[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: tags.id,
      user_id: tags.userId,
      account_id: tags.accountId,
      name: tags.name,
      color: tags.color,
      created_at: tags.createdAt,
    })
    .from(tags)
    .where(eq(tags.accountId, ctx.accountId))
  return rows as unknown as Tag[]
}

export interface ContactExportRow {
  phone: string
  name: string
  email: string
  company: string
  /** Customer codes joined by "; " (Felipe/cema — pra reimportar no ERP). */
  codigo_cliente: string
  /** Tag names joined by "; ". */
  tags: string
}

/**
 * All contacts in the account, flattened for a CSV export (Felipe/cema:
 * levar o código de volta pro sistema deles). Includes the customer codes
 * and tag names. Account-scoped.
 */
export async function exportContacts(): Promise<ContactExportRow[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: contacts.id,
      phone: contacts.phone,
      name: contacts.name,
      email: contacts.email,
      company: contacts.company,
      codes: contacts.customerCodes,
    })
    .from(contacts)
    .where(eq(contacts.accountId, ctx.accountId))
    .orderBy(desc(contacts.createdAt))

  const tagRows = await db
    .select({ contactId: contactTags.contactId, name: tags.name })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(eq(tags.accountId, ctx.accountId))
  const tagsByContact = new Map<string, string[]>()
  for (const t of tagRows) {
    const arr = tagsByContact.get(t.contactId) ?? []
    arr.push(t.name)
    tagsByContact.set(t.contactId, arr)
  }

  return rows.map((r) => ({
    phone: r.phone,
    name: r.name ?? '',
    email: r.email ?? '',
    company: r.company ?? '',
    codigo_cliente: (r.codes ?? []).join('; '),
    tags: (tagsByContact.get(r.id) ?? []).join('; '),
  }))
}

export interface ListContactsInput {
  /** Zero-based row offset. */
  offset: number
  limit: number
  /** Trimmed search term ('' = no search). */
  search: string
  /** Tag filter — contacts must have ANY of these tags (OR). */
  tagIds: string[]
}

/**
 * Paginated, searchable contact listing. When `tagIds` is non-empty the
 * `filter_contacts_by_tags` SQL function (migration 025; account param
 * added when RLS was dropped) resolves the join + distinct + windowed
 * count server-side.
 */
export async function listContacts(
  input: ListContactsInput,
): Promise<{ contacts: Contact[]; count: number }> {
  const ctx = await getCurrentAccount()
  const term = input.search.trim()

  if (input.tagIds.length > 0) {
    const result = await db.execute(sql`
      SELECT to_jsonb(contact) AS contact, total_count
      FROM filter_contacts_by_tags(
        ${ctx.accountId}::uuid,
        ${input.tagIds}::uuid[],
        ${term || null},
        ${input.limit},
        ${input.offset}
      )
    `)
    const rows = result.rows as unknown as {
      contact: Contact
      total_count: string | number
    }[]
    return {
      contacts: rows.map((r) => r.contact),
      count: rows.length > 0 ? Number(rows[0].total_count) : 0,
    }
  }

  const like = `%${term}%`
  const where = term
    ? and(
        eq(contacts.accountId, ctx.accountId),
        or(
          ilike(contacts.name, like),
          ilike(contacts.phone, like),
          ilike(contacts.email, like),
        ),
      )
    : eq(contacts.accountId, ctx.accountId)

  const [rows, total] = await Promise.all([
    db
      .select(contactColumns)
      .from(contacts)
      .where(where)
      .orderBy(desc(contacts.createdAt))
      .limit(input.limit)
      .offset(input.offset),
    firstOrThrow(await db.select({ n: count() }).from(contacts).where(where)),
  ])

  return { contacts: rows as unknown as Contact[], count: total.n }
}

/** contact_id → tag_id pairs for a set of contacts (tag chips in the table). */
export async function listContactTagPairs(
  contactIds: string[],
): Promise<{ contact_id: string; tag_id: string }[]> {
  if (contactIds.length === 0) return []
  const ctx = await getCurrentAccount()
  return db
    .select({
      contact_id: contactTags.contactId,
      tag_id: contactTags.tagId,
    })
    .from(contactTags)
    .innerJoin(contacts, eq(contactTags.contactId, contacts.id))
    .where(
      and(inArray(contactTags.contactId, contactIds), eq(contacts.accountId, ctx.accountId)),
    )
}

/** Full contact_tags rows for one contact (edit form). */
export async function getContactTags(contactId: string): Promise<ContactTag[]> {
  const ctx = await getCurrentAccount()
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!owned) return []
  const rows = await db
    .select({
      id: contactTags.id,
      contact_id: contactTags.contactId,
      tag_id: contactTags.tagId,
    })
    .from(contactTags)
    .where(eq(contactTags.contactId, contactId))
  return rows as ContactTag[]
}

/** Delete one or more contacts. Returns an error message or null. */
export async function deleteContacts(
  contactIds: string[],
): Promise<{ error: string | null }> {
  if (contactIds.length === 0) return { error: null }
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(contacts)
      .where(and(inArray(contacts.id, contactIds), eq(contacts.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete contacts' }
  }
}

// ============================================================
// Contact form (create/edit + duplicate detection)
// ============================================================

/**
 * On-blur duplicate check for the NEW-contact form. Returns the existing
 * contact (if any) plus whether it is an *exact* normalized match. The
 * dedupe helper imports @/db, so this must run server-side.
 */
export async function checkDuplicatePhone(
  phone: string,
): Promise<{ contact: ExistingContact; exact: boolean } | null> {
  const value = phone.trim()
  if (!value) return null
  const ctx = await getCurrentAccount()
  const existing = await findExistingContact(ctx.accountId, value)
  if (!existing) return null
  return { contact: existing, exact: isExactMatch(existing, value) }
}

export interface SaveContactInput {
  /** Present → update that contact; absent → create. */
  contactId?: string | null
  name: string
  phone: string
  email: string
  company: string
  /** Full desired set of tag ids (delete + reinsert to match). */
  tagIds: string[]
}

export type SaveContactResult =
  | { ok: true; contactId: string }
  /** Exact/unique-violation duplicate. `existing` set for new contacts so
   *  the form can surface the "view existing" notice. */
  | { ok: false; duplicate: true; existing: ExistingContact | null }
  | { ok: false; duplicate: false; error: string }

/**
 * Empresa como entidade: dado o texto "empresa" de um contato, acha (por conta,
 * case-insensitive) ou cria a Empresa e devolve o id — mantendo a entidade em
 * sincronia com o texto, sem mudar a UX do form. Vazio → null.
 */
async function resolveCompanyId(
  accountId: string,
  userId: string,
  companyText: string | null,
): Promise<string | null> {
  const name = (companyText ?? '').trim()
  if (!name) return null
  const find = async () =>
    firstOrNull(
      await db
        .select({ id: companies.id })
        .from(companies)
        .where(
          and(
            eq(companies.accountId, accountId),
            sql`lower(${companies.name}) = lower(${name})`,
          ),
        )
        .limit(1),
    )
  const existing = await find()
  if (existing) return existing.id
  try {
    const inserted = firstOrThrow(
      await db
        .insert(companies)
        .values({ accountId, name, createdBy: userId })
        .returning({ id: companies.id }),
    )
    return inserted.id
  } catch {
    // Corrida no índice único (account_id, lower(name)) → relê.
    return (await find())?.id ?? null
  }
}

/**
 * Create or update a contact and sync its contact_tags (delete + reinsert
 * the selected set). A unique-phone violation is reported as a duplicate
 * signal (not a hard error) so the form can show its friendly notice.
 */
export async function saveContact(
  input: SaveContactInput,
): Promise<SaveContactResult> {
  const ctx = await getCurrentAccount()
  const phone = input.phone.trim()
  if (!phone) return { ok: false, duplicate: false, error: 'Phone number is required' }
  // Reject a malformed number at save time instead of letting it through and
  // failing later (silently) at send time. Real incident: a contact saved as
  // "01528999632794" (leading 0, 14 digits) passed here and only surfaced as
  // "Invalid phone number format" when someone tried to message them.
  if (!isValidE164(sanitizePhoneForMeta(phone))) {
    return {
      ok: false,
      duplicate: false,
      error:
        'Telefone inválido. Use o formato internacional, ex.: +55 28 99999-9999.',
    }
  }

  const name = input.name.trim() || null
  const email = input.email.trim() || null
  const company = input.company.trim() || null
  // Empresa como entidade: acha/cria a Empresa pelo texto e vincula (company_id).
  const companyId = await resolveCompanyId(ctx.accountId, ctx.userId, company)

  try {
    let contactId = input.contactId ?? undefined

    if (contactId) {
      // Update — scoped to the caller's account.
      const updated = await db
        .update(contacts)
        .set({
          name,
          phone,
          email,
          company,
          companyId,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .returning({ id: contacts.id })
      const row = firstOrNull(updated)
      if (!row) return { ok: false, duplicate: false, error: 'Contact not found' }
      contactId = row.id
    } else {
      const inserted = await db
        .insert(contacts)
        .values({
          userId: ctx.userId,
          accountId: ctx.accountId,
          name,
          phone,
          email,
          company,
          companyId,
        })
        .returning({ id: contacts.id })
      contactId = firstOrThrow(inserted).id
    }

    // Sync tags: delete then reinsert the selected set.
    await db.delete(contactTags).where(eq(contactTags.contactId, contactId))
    if (input.tagIds.length > 0) {
      await db.insert(contactTags).values(
        input.tagIds.map((tagId) => ({ contactId: contactId!, tagId })),
      )
    }

    return { ok: true, contactId }
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Only surface an existing record for new contacts.
      let existing: ExistingContact | null = null
      if (!input.contactId) {
        try {
          existing = await findExistingContact(ctx.accountId, phone)
        } catch {
          existing = null
        }
      }
      return { ok: false, duplicate: true, existing }
    }
    return {
      ok: false,
      duplicate: false,
      error: err instanceof Error ? err.message : 'Failed to save contact',
    }
  }
}

// ============================================================
// CSV import
// ============================================================

export interface ImportContactRow {
  phone: string
  name?: string
  email?: string
  company?: string
  tagNames: string[]
  /** Customer codes from the código column (Felipe/cema). */
  codes?: string[]
}

export interface ImportContactsResult {
  imported: number
  /** Duplicates left untouched (only when `overwrite` is false). */
  skipped: number
  /** Existing contacts whose data was overwritten (only when `overwrite`). */
  overwritten: number
  failed: number
  tagsAssigned: number
  /** Tag names that could not be matched/created (non-admin callers). */
  skippedTagNames: string[]
  /** True if a tag-assignment step failed after contacts were created. */
  tagAssignmentFailed: boolean
}

export interface ImportContactsOptions {
  /**
   * When true, a CSV row matching an EXISTING contact (9th-digit tolerant)
   * overwrites that contact's data — name/email/company/codes the file
   * provides win; blank cells keep the current value (so a sparse sheet
   * doesn't wipe fields). Tags in the row are (re)assigned. Default false:
   * duplicates are counted in `skipped` and left as-is (the two-step flow —
   * import first, then the user confirms "sobrescrever N").
   */
  overwrite?: boolean
}

/**
 * Execute a CSV import server-side: in-file dedupe, skip numbers already in
 * the account, batch-insert new contacts (unique-violation counts as
 * skipped), resolve/auto-create tag names, and wire contact_tags. Tag
 * auto-creation is gated on admin+ (`canManageMembers`), re-derived from
 * `ctx.role` here — the client-passed intent is not trusted.
 */
export async function importContacts(
  rows: ImportContactRow[],
  opts: ImportContactsOptions = {},
): Promise<ImportContactsResult> {
  const ctx = await getCurrentAccount()
  // admin+ may auto-create missing tags.
  const canCreateTags = ctx.role === 'owner' || ctx.role === 'admin'
  const overwrite = opts.overwrite === true

  let imported = 0
  let skipped = 0
  let overwritten = 0
  let failed = 0

  // 0) Normalize each phone to E.164 up front — a CSV of Brazilian numbers in
  //    national-dialing form ("0 + operadora + DDD + número") would otherwise be
  //    imported unsendable (leading 0 fails isValidE164), exactly like the
  //    inbound path used to. Doing it here (before dedupe + the "already in
  //    account" check) also makes those checks compare the right digits, so an
  //    imported number correctly matches an existing 55… contact. Only touches
  //    numbers starting with 0, so clean numbers pass through unchanged.
  const normalizedRows = rows.map((r) => ({
    ...r,
    phone: normalizeInboundPhoneBR(r.phone),
  }))

  // 1) In-file dedupe by normalized phone (keep first).
  const { unique, duplicates: inFileDupes } = dedupeByPhone(normalizedRows)
  skipped += inFileDupes

  // 2) Match against numbers already in this account using the SAME
  //    9th-digit / trunk-tolerant rule the webhook + contact form use
  //    (last-8 suffix + phonesMatch), NOT an exact-digits set — otherwise a
  //    "5511947650435" in the file would miss an existing "551147650435"
  //    (or vice-versa) and slip through as a fresh duplicate. Pre-filter in
  //    SQL by suffix so we don't pull the whole account.
  const suffixes = [
    ...new Set(unique.map((r) => last8(r.phone)).filter(Boolean)),
  ]
  let existingContacts: { id: string; phone: string }[] = []
  if (suffixes.length > 0) {
    existingContacts = (await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, ctx.accountId),
          inArray(sql`right(${contacts.phoneNormalized}, 8)`, suffixes),
        ),
      )) as { id: string; phone: string }[]
  }
  const matchExisting = (phone: string) =>
    existingContacts.find((c) => c.phone && phonesMatch(c.phone, phone)) ?? null

  // Classify each unique row: brand-new → insert; already-present →
  // overwrite (when asked) or skip.
  const toInsert: typeof unique = []
  const toOverwrite: { id: string; row: (typeof unique)[number] }[] = []
  for (const row of unique) {
    const hit = matchExisting(row.phone)
    if (hit) {
      if (overwrite) toOverwrite.push({ id: hit.id, row })
      else skipped++
    } else {
      toInsert.push(row)
    }
  }

  // 3) Resolve tag names → ids (admin+ auto-creates missing). Include the
  //    overwrite rows so their tags resolve too.
  const allTagNames = [
    ...toInsert.flatMap((row) => row.tagNames),
    ...toOverwrite.flatMap((o) => o.row.tagNames),
  ]
  let tagIdByKey = new Map<string, string>()
  let skippedTagNames: string[] = []
  if (allTagNames.length > 0) {
    ;({ tagIdByKey, skippedNames: skippedTagNames } = await resolveImportTagIds({
      accountId: ctx.accountId,
      userId: ctx.userId,
      tagNames: allTagNames,
      canCreateTags,
    }))
  }

  const tagAssignments: ContactTagAssignment[] = []

  // 4) Batch-insert new contacts in chunks; a unique violation on a chunk
  //    falls back to per-row inserts so one bad row doesn't sink the chunk.
  const chunkSize = 50
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize)
    const values = chunk.map((row) => ({
      userId: ctx.userId,
      accountId: ctx.accountId,
      phone: row.phone,
      name: row.name || null,
      email: row.email || null,
      company: row.company || null,
      customerCodes: row.codes ?? [],
    }))

    try {
      const insertedRows = await db
        .insert(contacts)
        .values(values)
        .returning({ id: contacts.id })
      imported += insertedRows.length
      // RETURNING preserves input order for a single INSERT.
      for (let j = 0; j < insertedRows.length; j++) {
        const source = chunk[j]
        if (!source || source.tagNames.length === 0) continue
        tagAssignments.push({
          contactId: insertedRows[j].id,
          tagNames: source.tagNames,
        })
      }
    } catch {
      // Retry individually.
      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j]
        try {
          const single = await db
            .insert(contacts)
            .values(values[j])
            .returning({ id: contacts.id })
          const row = firstOrNull(single)
          if (row) {
            imported++
            if (source.tagNames.length > 0) {
              tagAssignments.push({ contactId: row.id, tagNames: source.tagNames })
            }
          } else {
            failed++
          }
        } catch (singleErr) {
          if (isUniqueViolation(singleErr)) skipped++
          else failed++
        }
      }
    }
  }

  // 4b) Overwrite the matched existing contacts (opt-in). "Sobrescrever" =
  //     the file's values win, but a blank cell keeps the current value so a
  //     sparse sheet can't wipe an email/name that's already there. Tags in
  //     the row are (re)assigned via the same tagAssignments path.
  for (const { id, row } of toOverwrite) {
    const set: Record<string, unknown> = {}
    if (row.name) set.name = row.name
    if (row.email) set.email = row.email
    if (row.company) set.company = row.company
    if (row.codes && row.codes.length > 0) set.customerCodes = row.codes
    try {
      if (Object.keys(set).length > 0) {
        await db
          .update(contacts)
          .set(set)
          .where(and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)))
      }
      overwritten++
      if (row.tagNames.length > 0) {
        tagAssignments.push({ contactId: id, tagNames: row.tagNames })
      }
    } catch {
      failed++
    }
  }

  // 5) Wire tags; a failure here must not mask a successful import.
  let tagsAssigned = 0
  let tagAssignmentFailed = false
  try {
    tagsAssigned = await assignImportedContactTags(tagAssignments, tagIdByKey)
  } catch {
    tagAssignmentFailed = true
  }

  return {
    imported,
    skipped,
    overwritten,
    failed,
    tagsAssigned,
    skippedTagNames,
    tagAssignmentFailed,
  }
}

export interface ImportContactsPreview {
  /** Rows that would create a NEW contact. */
  newCount: number
  /** Rows that match an EXISTING contact (9th-digit tolerant). */
  duplicateCount: number
}

/**
 * Dry-run of the import: classifies the parsed rows into new vs.
 * already-present WITHOUT writing, so the modal can tell the user
 * "X novos · Y já cadastrados" and offer to overwrite the Y before
 * committing. Uses the exact same normalize + dedupe + 9th-digit-tolerant
 * matching as {@link importContacts}, so the numbers line up.
 */
export async function previewImportContacts(
  rows: ImportContactRow[],
): Promise<ImportContactsPreview> {
  const ctx = await getCurrentAccount()

  const normalizedRows = rows.map((r) => ({
    ...r,
    phone: normalizeInboundPhoneBR(r.phone),
  }))
  const { unique } = dedupeByPhone(normalizedRows)

  const suffixes = [
    ...new Set(unique.map((r) => last8(r.phone)).filter(Boolean)),
  ]
  let existingContacts: { phone: string }[] = []
  if (suffixes.length > 0) {
    existingContacts = (await db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, ctx.accountId),
          inArray(sql`right(${contacts.phoneNormalized}, 8)`, suffixes),
        ),
      )) as { phone: string }[]
  }

  let duplicateCount = 0
  for (const row of unique) {
    if (existingContacts.some((c) => c.phone && phonesMatch(c.phone, row.phone))) {
      duplicateCount++
    }
  }
  return { newCount: unique.length - duplicateCount, duplicateCount }
}

// ============================================================
// Import modal tag colors (preview chips)
// ============================================================

/** name(lowercased) → color, for the import preview's tag chips. */
export async function listTagColors(): Promise<Record<string, string>> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({ name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.accountId, ctx.accountId))
  const out: Record<string, string> = {}
  for (const tag of rows) {
    const key = tag.name.trim().toLowerCase()
    if (!(key in out)) out[key] = tag.color
  }
  return out
}

// ============================================================
// Contact detail view
// ============================================================

/** One contact by id, scoped to the account. */
export async function getContact(contactId: string): Promise<Contact | null> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select(contactColumns)
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
    .limit(1)
  return (firstOrNull(rows) as unknown as Contact) ?? null
}

/** tag_id list currently on a contact (detail view Tags tab). */
export async function listContactTagIds(contactId: string): Promise<string[]> {
  const ctx = await getCurrentAccount()
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!owned) return []
  const rows = await db
    .select({ tagId: contactTags.tagId })
    .from(contactTags)
    .where(eq(contactTags.contactId, contactId))
  return rows.map((r) => r.tagId)
}

/** Add or remove one tag on a contact. Returns updated success flag. */
export async function toggleContactTag(
  contactId: string,
  tagId: string,
  add: boolean,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const owned = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Contact not found' }
    // Guard the tag belongs to the account too.
    const tagOwned = firstOrNull(
      await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!tagOwned) return { error: 'Tag not found' }

    if (add) {
      const inserted = await db
        .insert(contactTags)
        .values({ contactId, tagId })
        .onConflictDoNothing({ target: [contactTags.contactId, contactTags.tagId] })
        .returning({ contactId: contactTags.contactId })
      // Genuine new add → fire tag_added flows (best-effort).
      if (inserted.length > 0) {
        void dispatchTagAddedToFlows(ctx.accountId, contactId, tagId).catch(
          (err) => console.error('[flows] tag_added dispatch failed:', err),
        )
      }
    } else {
      await db
        .delete(contactTags)
        .where(and(eq(contactTags.contactId, contactId), eq(contactTags.tagId, tagId)))
    }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update tag' }
  }
}

/** Update a contact's core details (detail view Details tab). */
export async function updateContactDetails(input: {
  contactId: string
  name: string
  phone: string
  email: string
  company: string
}): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const phone = input.phone.trim()
    if (!phone) return { error: 'Phone number is required' }
    const company = input.company.trim() || null
    const companyId = await resolveCompanyId(ctx.accountId, ctx.userId, company)
    const updated = await db
      .update(contacts)
      .set({
        name: input.name.trim() || null,
        phone,
        email: input.email.trim() || null,
        company,
        companyId,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(eq(contacts.id, input.contactId), eq(contacts.accountId, ctx.accountId)),
      )
      .returning({ id: contacts.id })
    if (!firstOrNull(updated)) return { error: 'Contact not found' }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to update contact' }
  }
}

/** Notes for a contact, newest first. */
export async function listContactNotes(contactId: string): Promise<ContactNote[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: contactNotes.id,
      contact_id: contactNotes.contactId,
      user_id: contactNotes.userId,
      note_text: contactNotes.noteText,
      created_at: contactNotes.createdAt,
    })
    .from(contactNotes)
    .where(
      and(
        eq(contactNotes.contactId, contactId),
        eq(contactNotes.accountId, ctx.accountId),
      ),
    )
    .orderBy(desc(contactNotes.createdAt))
  return rows as unknown as ContactNote[]
}

/** Add a note to a contact. Author is the caller. */
export async function addContactNote(
  contactId: string,
  noteText: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const text = noteText.trim()
    if (!text) return { error: 'Note is empty' }
    const owned = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Contact not found' }
    await db.insert(contactNotes).values({
      contactId,
      accountId: ctx.accountId,
      userId: ctx.userId,
      noteText: text,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to add note' }
  }
}

/** Delete a note (scoped to the account). */
export async function deleteContactNote(
  noteId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    await db
      .delete(contactNotes)
      .where(and(eq(contactNotes.id, noteId), eq(contactNotes.accountId, ctx.accountId)))
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Failed to delete note' }
  }
}

/** All account custom-field definitions, ordered by name. */
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

/** custom_field_id → value for a contact. */
export async function listContactCustomValues(
  contactId: string,
): Promise<ContactCustomValue[]> {
  const ctx = await getCurrentAccount()
  const owned = firstOrNull(
    await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!owned) return []
  const rows = await db
    .select({
      id: contactCustomValues.id,
      contact_id: contactCustomValues.contactId,
      custom_field_id: contactCustomValues.customFieldId,
      value: contactCustomValues.value,
    })
    .from(contactCustomValues)
    .where(eq(contactCustomValues.contactId, contactId))
  return rows as unknown as ContactCustomValue[]
}

/**
 * Replace a contact's custom values with `values` (custom_field_id → value).
 * Delete-then-reinsert non-empty values, mirroring the old client behavior.
 */
export async function saveContactCustomValues(
  contactId: string,
  values: Record<string, string>,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    const owned = firstOrNull(
      await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)))
        .limit(1),
    )
    if (!owned) return { error: 'Contact not found' }

    await db
      .delete(contactCustomValues)
      .where(eq(contactCustomValues.contactId, contactId))

    const rows = Object.entries(values)
      .filter(([, val]) => val.trim())
      .map(([fieldId, val]) => ({
        contactId,
        customFieldId: fieldId,
        value: val.trim(),
      }))
    if (rows.length > 0) {
      await db.insert(contactCustomValues).values(rows)
    }
    return { error: null }
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Failed to save custom fields',
    }
  }
}

/** Deals for a contact (with stage), newest first. */
export async function listContactDeals(contactId: string): Promise<Deal[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: deals.id,
      user_id: deals.userId,
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
      stage_pk: pipelineStages.id,
      stage_pipeline_id: pipelineStages.pipelineId,
      stage_name: pipelineStages.name,
      stage_position: pipelineStages.position,
      stage_color: pipelineStages.color,
      stage_created_at: pipelineStages.createdAt,
    })
    .from(deals)
    .leftJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
    .where(and(eq(deals.contactId, contactId), eq(deals.accountId, ctx.accountId)))
    .orderBy(desc(deals.createdAt))

  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    pipeline_id: r.pipeline_id,
    stage_id: r.stage_id,
    contact_id: r.contact_id,
    conversation_id: r.conversation_id ?? undefined,
    assigned_to: r.assigned_to ?? undefined,
    title: r.title,
    value: Number(r.value),
    currency: r.currency ?? undefined,
    notes: r.notes ?? undefined,
    expected_close_date: r.expected_close_date ?? undefined,
    status: (r.status ?? undefined) as Deal['status'],
    created_at: r.created_at as string,
    updated_at: (r.updated_at ?? undefined) as string | undefined,
    stage: r.stage_pk
      ? {
          id: r.stage_pk,
          pipeline_id: r.stage_pipeline_id as string,
          name: r.stage_name as string,
          position: r.stage_position as number,
          color: r.stage_color as string,
          created_at: r.stage_created_at as string,
        }
      : undefined,
  })) as Deal[]
}

// ============================================================
// Custom-fields manager (field catalogue CRUD, admin+)
// ============================================================

/** Create a custom field definition. Admin+ only. */
export async function createCustomField(
  fieldName: string,
  // 'text' (input livre) ou 'select' (opções pré-definidas, estilo RD).
  fieldType: 'text' | 'select' = 'text',
  options: string[] = [],
): Promise<{ error: string | null }> {
  const name = fieldName.trim()
  if (!name) return { error: 'Field name is required' }
  const cleanOptions = Array.from(
    new Set(options.map((o) => o.trim()).filter(Boolean)),
  )
  if (fieldType === 'select' && cleanOptions.length === 0) {
    return { error: 'Um campo de seleção precisa de pelo menos uma opção.' }
  }
  try {
    const ctx = await getCurrentAccount()
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return { error: 'You do not have permission to manage custom fields.' }
    }
    const clash = firstOrNull(
      await db
        .select({ id: customFields.id })
        .from(customFields)
        .where(
          and(
            eq(customFields.accountId, ctx.accountId),
            ilike(customFields.fieldName, name),
          ),
        )
        .limit(1),
    )
    if (clash) return { error: `A field named "${name}" already exists.` }
    await db.insert(customFields).values({
      fieldName: name,
      fieldType,
      fieldOptions: fieldType === 'select' ? { options: cleanOptions } : null,
      userId: ctx.userId,
      accountId: ctx.accountId,
    })
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not create field.' }
  }
}

/** Rename a custom field definition. Admin+ only. */
export async function renameCustomField(
  fieldId: string,
  nextName: string,
): Promise<{ error: string | null }> {
  const name = nextName.trim()
  if (!name) return { error: 'Field name is required' }
  try {
    const ctx = await getCurrentAccount()
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return { error: 'You do not have permission to manage custom fields.' }
    }
    const clash = firstOrNull(
      await db
        .select({ id: customFields.id })
        .from(customFields)
        .where(
          and(
            eq(customFields.accountId, ctx.accountId),
            ilike(customFields.fieldName, name),
          ),
        )
        .limit(1),
    )
    if (clash && clash.id !== fieldId) {
      return { error: `A field named "${name}" already exists.` }
    }
    const updated = await db
      .update(customFields)
      .set({ fieldName: name })
      .where(
        and(eq(customFields.id, fieldId), eq(customFields.accountId, ctx.accountId)),
      )
      .returning({ id: customFields.id })
    if (!firstOrNull(updated)) return { error: 'Field not found' }
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not rename field.' }
  }
}

/** Delete a custom field definition (and its stored values). Admin+ only. */
export async function deleteCustomField(
  fieldId: string,
): Promise<{ error: string | null }> {
  try {
    const ctx = await getCurrentAccount()
    if (ctx.role !== 'owner' && ctx.role !== 'admin') {
      return { error: 'You do not have permission to manage custom fields.' }
    }
    await db
      .delete(customFields)
      .where(
        and(eq(customFields.id, fieldId), eq(customFields.accountId, ctx.accountId)),
      )
    return { error: null }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not delete field.' }
  }
}

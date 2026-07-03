'use server'

// ============================================================
// Server actions for the Contacts page. Replaces the Supabase
// browser-client queries the page used pre-Drizzle. Every query is
// scoped to the caller's account — there is no RLS anymore.
// ============================================================

import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import { db, contacts, contactTags, tags } from '@/db'
import { firstOrNull, firstOrThrow } from '@/db/helpers'
import { getCurrentAccount } from '@/lib/auth/account'
import type { Contact, ContactTag, Tag } from '@/types'

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

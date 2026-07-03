// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import { and, eq, inArray } from 'drizzle-orm';

import { db, member, contactTags, contacts, tags, whatsappConfig } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };

/** Flatten a contact row + embedded tag joins into the public shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  return {
    id: row.id as string,
    phone: row.phone as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Fetch the tags of `contactIds` in one query, grouped per contact.
 * Replaces the old PostgREST `contact_tags(tags(*))` embed for the v1
 * contact routes.
 */
export async function loadTagsByContact(
  contactIds: string[]
): Promise<Map<string, { id: string; name: string; color: string }[]>> {
  const byContact = new Map<string, { id: string; name: string; color: string }[]>();
  if (contactIds.length === 0) return byContact;

  const rows = await db
    .select({
      contactId: contactTags.contactId,
      id: tags.id,
      name: tags.name,
      color: tags.color,
    })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(inArray(contactTags.contactId, contactIds));

  for (const row of rows) {
    const list = byContact.get(row.contactId) ?? [];
    list.push({ id: row.id, name: row.name, color: row.color });
    byContact.set(row.contactId, list);
  }
  return byContact;
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **WhatsApp config owner** (the webhook's own convention). Contacts
 * can be created before WhatsApp is connected, so we fall back to the
 * account owner when there's no config yet.
 */
export async function resolveAuditUserId(accountId: string): Promise<string> {
  const config = firstOrNull(
    await db
      .select({ userId: whatsappConfig.userId })
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, accountId))
      .limit(1)
  );
  if (config?.userId) return config.userId;

  const owner = firstOrNull(
    await db
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, accountId), eq(member.role, 'owner')))
      .limit(1)
  );
  if (!owner?.userId) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner.userId;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Find (by fuzzy phone match) or create a contact in `accountId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 */
export async function findOrCreateContact(
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const existing = await findExistingContact(accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  try {
    const created = firstOrNull(
      await db
        .insert(contacts)
        .values({
          accountId,
          userId: auditUserId,
          phone: sanitized,
          name: input.name ?? sanitized,
          email: input.email ?? null,
          company: input.company ?? null,
        })
        .returning({ id: contacts.id })
    );
    if (!created) {
      throw new ContactError('Failed to create contact', 500);
    }
    return { id: created.id, created: true };
  } catch (error) {
    // Lost a race against a concurrent create — the unique index
    // rejected the duplicate. Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    if (error instanceof ContactError) throw error;
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). A no-op when `tagNames` is
 * undefined — pass `[]` to clear all tags. Reuses `resolveImportTagIds`
 * so API and CSV-import tag handling stay consistent.
 */
export async function setContactTags(
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds({
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  const desired = new Set(tagIdByKey.values());

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  let existing: Set<string>;
  try {
    const current = await db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .where(eq(contactTags.contactId, contactId));
    existing = new Set(current.map((r) => r.tagId));
  } catch {
    throw new ContactError('Failed to read contact tags', 500);
  }

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  try {
    if (toRemove.length > 0) {
      await db
        .delete(contactTags)
        .where(
          and(
            eq(contactTags.contactId, contactId),
            inArray(contactTags.tagId, toRemove)
          )
        );
    }
    if (toAdd.length > 0) {
      await db
        .insert(contactTags)
        .values(toAdd.map((tagId) => ({ contactId, tagId })));
    }
  } catch {
    throw new ContactError('Failed to update contact tags', 500);
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1)
  );
  if (!row) return null;

  const tagsByContact = await loadTagsByContact([row.id]);

  return {
    id: row.id,
    phone: row.phone,
    name: row.name ?? null,
    email: row.email ?? null,
    company: row.company ?? null,
    avatar_url: row.avatarUrl ?? null,
    tags: tagsByContact.get(row.id) ?? [],
    created_at: row.createdAt ?? '',
    updated_at: row.updatedAt ?? '',
  };
}

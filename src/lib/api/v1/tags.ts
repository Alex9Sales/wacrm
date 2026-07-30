// ============================================================
// Public API (v1) helpers for tags (labels).
//
// Tags are account-level labels that live ON CONTACTS (contact_tags).
// The public API exposes them two ways:
//   • /api/v1/tags            — manage the account's tag catalog
//   • /api/v1/conversations/{id}/tags — tag the conversation's contact
// so Hermes / an n8n workflow can create labels and flag threads, and a
// team member sees the label on the conversation card.
// ============================================================

import { and, eq, sql } from 'drizzle-orm';

import { db, contactTags, conversations, tags } from '@/db';
import { firstOrNull } from '@/db/helpers';

export interface ApiTag {
  id: string;
  name: string;
  color: string;
}

const DEFAULT_TAG_COLOR = '#3b82f6';

export function serializeTag(row: {
  id: string;
  name: string;
  color: string;
}): ApiTag {
  return { id: row.id, name: row.name, color: row.color };
}

/** All tags in the account, alphabetical. */
export async function listAccountTags(accountId: string): Promise<ApiTag[]> {
  const rows = await db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.accountId, accountId))
    .orderBy(tags.name);
  return rows.map(serializeTag);
}

/** Find a tag by exact (case-insensitive) name within the account. */
export async function findTagByName(
  accountId: string,
  name: string,
): Promise<ApiTag | null> {
  const row = firstOrNull(
    await db
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(
        and(
          eq(tags.accountId, accountId),
          sql`lower(${tags.name}) = lower(${name})`,
        ),
      )
      .limit(1),
  );
  return row ? serializeTag(row) : null;
}

/**
 * Idempotent create-or-get by name (case-insensitive). Re-running an
 * n8n "setup" workflow that creates the same labels is a no-op instead
 * of piling up duplicates. `created` tells the caller which happened.
 */
export async function createOrGetTag(
  accountId: string,
  userId: string,
  input: { name: string; color?: string },
): Promise<{ tag: ApiTag; created: boolean }> {
  const name = input.name.trim();
  const existing = await findTagByName(accountId, name);
  if (existing) return { tag: existing, created: false };

  const row = firstOrNull(
    await db
      .insert(tags)
      .values({
        accountId,
        userId,
        name,
        color: input.color?.trim() || DEFAULT_TAG_COLOR,
      })
      .returning({ id: tags.id, name: tags.name, color: tags.color }),
  );
  // Lost a race → the unique-by-name resolves to the winner.
  if (!row) {
    const raced = await findTagByName(accountId, name);
    if (raced) return { tag: raced, created: false };
    throw new Error('Failed to create tag');
  }
  return { tag: serializeTag(row), created: true };
}

/** The contact behind a conversation, scoped to the account (or null). */
export async function contactIdForConversation(
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ contactId: conversations.contactId })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.accountId, accountId),
        ),
      )
      .limit(1),
  );
  return row?.contactId ?? null;
}

/** Tags currently on a contact. */
export async function listContactTags(contactId: string): Promise<ApiTag[]> {
  const rows = await db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(contactTags)
    .innerJoin(tags, eq(contactTags.tagId, tags.id))
    .where(eq(contactTags.contactId, contactId))
    .orderBy(tags.name);
  return rows.map(serializeTag);
}

/** Attach a tag to a contact (idempotent). */
export async function addTagToContact(
  contactId: string,
  tagId: string,
): Promise<void> {
  await db
    .insert(contactTags)
    .values({ contactId, tagId })
    .onConflictDoNothing({
      target: [contactTags.contactId, contactTags.tagId],
    });
}

/** Detach a tag from a contact. */
export async function removeTagFromContact(
  contactId: string,
  tagId: string,
): Promise<void> {
  await db
    .delete(contactTags)
    .where(
      and(eq(contactTags.contactId, contactId), eq(contactTags.tagId, tagId)),
    );
}

/** Confirm a tag id belongs to the account (before attaching it). */
export async function tagBelongsToAccount(
  accountId: string,
  tagId: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.accountId, accountId)))
      .limit(1),
  );
  return !!row;
}

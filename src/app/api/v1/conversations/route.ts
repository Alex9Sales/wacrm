// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags (loaded in a second bounded query, replacing the old PostgREST
// `contact:contacts(*, contact_tags(tags(*)))` embed).
// ============================================================

import { and, desc, eq, lt, or } from 'drizzle-orm';

import { db, contacts, conversations } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { loadTagsByContact } from '@/lib/api/v1/contacts';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    const conditions = [eq(conversations.accountId, ctx.accountId)];
    if (status) conditions.push(eq(conversations.status, status));
    if (contactId) conditions.push(eq(conversations.contactId, contactId));

    if (cursor) {
      conditions.push(
        or(
          lt(conversations.createdAt, cursor.createdAt),
          and(
            eq(conversations.createdAt, cursor.createdAt),
            lt(conversations.id, cursor.id)
          )
        )!
      );
    }

    let rows;
    try {
      rows = await db
        .select({
          id: conversations.id,
          contact_id: conversations.contactId,
          status: conversations.status,
          assigned_agent_id: conversations.assignedAgentId,
          last_message_text: conversations.lastMessageText,
          last_message_at: conversations.lastMessageAt,
          unread_count: conversations.unreadCount,
          created_at: conversations.createdAt,
          updated_at: conversations.updatedAt,
          contact: {
            id: contacts.id,
            phone: contacts.phone,
            name: contacts.name,
            email: contacts.email,
            company: contacts.company,
          },
        })
        .from(conversations)
        .leftJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(and(...conditions))
        .orderBy(desc(conversations.createdAt), desc(conversations.id))
        .limit(limit + 1);
    } catch (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = buildPage(
      rows as unknown as Array<{ created_at: string; id: string }>,
      limit
    ) as unknown as { items: typeof rows; nextCursor: string | null };

    const tagsByContact = await loadTagsByContact(
      items.map((r) => r.contact?.id).filter((id): id is string => id != null)
    );

    return okList(
      items.map((r) =>
        serializeConversation({
          ...r,
          contact: r.contact
            ? { ...r.contact, tags: tagsByContact.get(r.contact.id) ?? [] }
            : null,
        } as unknown as Conversation)
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

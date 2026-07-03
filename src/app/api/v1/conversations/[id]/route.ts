// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, contacts, conversations } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { loadTagsByContact } from '@/lib/api/v1/contacts';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    let row;
    try {
      row = firstOrNull(
        await db
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
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.accountId, ctx.accountId)
            )
          )
          .limit(1)
      );
    } catch (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }

    if (!row) return fail('not_found', 'Conversation not found', 404);

    const tagsByContact = await loadTagsByContact(
      row.contact ? [row.contact.id] : []
    );

    return ok(
      serializeConversation({
        ...row,
        contact: row.contact
          ? { ...row.contact, tags: tagsByContact.get(row.contact.id) ?? [] }
          : null,
      } as unknown as Conversation)
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

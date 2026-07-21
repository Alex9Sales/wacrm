// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';

import { db, conversations, messages } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import type { Message } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    // Gate on account ownership of the conversation first. A malformed
    // UUID throws where PostgREST returned an error object — both
    // collapse to the same 404.
    let conv: { id: string } | null = null;
    try {
      conv = firstOrNull(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, id),
              eq(conversations.accountId, ctx.accountId)
            )
          )
          .limit(1)
      );
    } catch {
      conv = null;
    }
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    // Internal notes are team-only. The public API (used by the AI agent /
    // Hermes to read history and reply to the customer) must never see them —
    // otherwise the agent could echo an internal note back to the customer.
    const conditions = [
      eq(messages.conversationId, id),
      eq(messages.isInternal, false),
    ];
    // ?direction=inbound → só o cliente; outbound → atendente/IA (agent+bot).
    const direction = new URL(request.url).searchParams.get('direction');
    if (direction === 'inbound') {
      conditions.push(eq(messages.senderType, 'customer'));
    } else if (direction === 'outbound') {
      conditions.push(inArray(messages.senderType, ['agent', 'bot']));
    }
    if (cursor) {
      conditions.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(
            eq(messages.createdAt, cursor.createdAt),
            lt(messages.id, cursor.id)
          )
        )!
      );
    }

    let rows;
    try {
      rows = await db
        .select({
          id: messages.id,
          conversation_id: messages.conversationId,
          sender_type: messages.senderType,
          sender_id: messages.senderId,
          content_type: messages.contentType,
          content_text: messages.contentText,
          media_url: messages.mediaUrl,
          template_name: messages.templateName,
          message_id: messages.messageId,
          status: messages.status,
          reply_to_message_id: messages.replyToMessageId,
          interactive_reply_id: messages.interactiveReplyId,
          created_at: messages.createdAt,
        })
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit + 1);
    } catch (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      rows as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((m) => serializeMessage(m as unknown as Message)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

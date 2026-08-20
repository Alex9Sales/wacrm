// ============================================================
// GET  /api/v1/conversations/{id}/messages — list a conversation's
//      messages (scope: messages:read), newest first, keyset-paginated.
// POST /api/v1/conversations/{id}/messages — send a message in the
//      conversation (scope: messages:send). Works on ANY channel: on an
//      e-mail/Gmail conversation it sends an e-mail. Body:
//        { "text": "olá", "media_url"?, "filename"?, "mimetype"? }
//
// The conversation is verified to belong to the key's account first — a
// foreign or unknown id → 404.
// ============================================================

import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';

import { db, conversations, messages } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams, buildPage } from '@/lib/api/v1/pagination';
import { serializeMessage } from '@/lib/api/v1/conversations';
import {
  sendMessageToConversation,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import type { Message } from '@/types';

/** Colunas serializadas de uma mensagem (compartilhado entre GET e POST). */
const MESSAGE_COLUMNS = {
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
} as const;

/** Tipo de mensagem a partir do mimetype do anexo (quando há media_url). */
function mediaKindFromMime(mime: string | null): string {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

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
        .select(MESSAGE_COLUMNS)
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');
    const { id } = await params;

    let body: {
      text?: unknown
      media_url?: unknown
      filename?: unknown
      mimetype?: unknown
      reply_to_message_id?: unknown
    };
    try {
      body = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    const text = typeof body.text === 'string' ? body.text : '';
    const mediaUrl =
      typeof body.media_url === 'string' && body.media_url ? body.media_url : null;
    const filename = typeof body.filename === 'string' ? body.filename : null;
    const mimetype = typeof body.mimetype === 'string' ? body.mimetype : null;
    const replyTo =
      typeof body.reply_to_message_id === 'string' ? body.reply_to_message_id : null;

    if (!mediaUrl && !text.trim()) {
      return badRequest('Provide `text` (or `media_url`).');
    }

    // Ownership 404 antes de enviar (mensagem de erro consistente com o GET).
    let conv: { id: string } | null = null;
    try {
      conv = firstOrNull(
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(eq(conversations.id, id), eq(conversations.accountId, ctx.accountId))
          )
          .limit(1)
      );
    } catch {
      conv = null;
    }
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    let result;
    try {
      result = await sendMessageToConversation(ctx.accountId, {
        conversationId: id,
        messageType: mediaUrl ? mediaKindFromMime(mimetype) : 'text',
        contentText: text || null,
        mediaUrl,
        filename,
        mimetype,
        replyToMessageId: replyTo,
      });
    } catch (err) {
      if (err instanceof SendMessageError) {
        return fail('send_failed', err.message, err.status ?? 400);
      }
      throw err;
    }

    // Devolve a mensagem persistida.
    const row = firstOrNull(
      await db
        .select(MESSAGE_COLUMNS)
        .from(messages)
        .where(eq(messages.id, result.messageId))
        .limit(1)
    );
    return ok(
      row
        ? serializeMessage(row as unknown as Message)
        : { id: result.messageId, message_id: result.whatsappMessageId },
      201
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ============================================================
// GET  /api/v1/conversations — list conversations (scope: conversations:read)
// POST /api/v1/conversations — inicia/reabre uma conversa com um destinatário
//      (scope: conversations:write). Body:
//        E-mail/Gmail:  { "channel_id", "email", "name"? }
//        WhatsApp:      { "channel_id", "phone", "name"? }
//      Devolve { conversation_id, contact_created } — depois use
//      POST /conversations/{id}/messages pra enviar. (Instagram/Messenger não
//      permitem iniciar: exigem a 1ª mensagem do cliente.)
//
// GET é keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed), `?contact_id=`, `?channel_id=`, `?contact_phone=`,
// `?created_after=` (ISO), and `?is_group=true|false`.
// ============================================================

import { and, desc, eq, gte, lt, or } from 'drizzle-orm';

import { db, contacts, conversations } from '@/db';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { loadChannel } from '@/lib/channels/channels';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, badRequest, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
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
    const channelId = url.searchParams.get('channel_id');
    const contactPhone = url.searchParams.get('contact_phone');
    const createdAfter = url.searchParams.get('created_after');
    // `?is_group=true` → só grupos (pra o agente monitorar); `false` → só 1:1.
    const isGroupParam = url.searchParams.get('is_group');

    const conditions = [eq(conversations.accountId, ctx.accountId)];
    if (status) conditions.push(eq(conversations.status, status));
    if (contactId) conditions.push(eq(conversations.contactId, contactId));
    if (channelId) conditions.push(eq(conversations.channelId, channelId));
    if (isGroupParam === 'true' || isGroupParam === 'false') {
      conditions.push(eq(contacts.isGroup, isGroupParam === 'true'));
    }
    if (contactPhone) {
      conditions.push(
        eq(contacts.phoneNormalized, normalizePhone(contactPhone)),
      );
    }
    if (createdAfter) {
      conditions.push(gte(conversations.createdAt, createdAfter));
    }

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
          channel_id: conversations.channelId,
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
            is_group: contacts.isGroup,
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

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');

    let body: {
      channel_id?: unknown
      email?: unknown
      phone?: unknown
      name?: unknown
    };
    try {
      body = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    const channelId = typeof body.channel_id === 'string' ? body.channel_id : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (!channelId) return badRequest('`channel_id` is required.');

    const channel = await loadChannel(channelId);
    if (!channel || channel.accountId !== ctx.accountId) {
      return fail('not_found', 'Channel not found', 404);
    }

    let resolved: { conversationId: string; contactCreated: boolean };
    if (channel.provider === 'email' || channel.provider === 'gmail') {
      const email =
        typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return badRequest('`email` is required for an e-mail/Gmail channel.');
      }
      const { resolveEmailConversation } = await import('@/lib/channels/inbound');
      resolved = await resolveEmailConversation(channel, email, name);
    } else if (
      channel.provider === 'meta' ||
      channel.provider === 'waha' ||
      channel.provider === 'evolution' ||
      channel.provider === 'evogo'
    ) {
      const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
      if (!phone) return badRequest('`phone` is required for a WhatsApp channel.');
      const { resolveConversationByPhone } = await import(
        '@/lib/whatsapp/resolve-conversation'
      );
      const r = await resolveConversationByPhone(ctx.accountId, phone, name, channelId);
      resolved = { conversationId: r.conversationId, contactCreated: r.contactCreated };
    } else {
      return badRequest(
        'Não dá pra iniciar conversa nesse canal (Instagram/Messenger exigem a 1ª mensagem do cliente).',
      );
    }

    return ok(
      {
        conversation_id: resolved.conversationId,
        contact_created: resolved.contactCreated,
      },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

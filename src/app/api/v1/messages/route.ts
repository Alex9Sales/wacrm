// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope. Account context
// comes from `requireApiKey`; queries run on the shared Drizzle
// client inside the lib helpers, always account-scoped.
//
// Body:
//   {
//     "to": "+14155550123",                 // required, E.164
//     "type": "text",                        // text|template|image|video|document|audio (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe"                     // optional, names a newly-created contact
//   }
//
// Response (201):
//   { "data": { "message_id", "whatsapp_message_id", "conversation_id",
//               "contact_id", "contact_created" } }
// ============================================================

import { and, eq } from 'drizzle-orm';

import { db, conversations } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // Two ways to target a send:
    //   • `to`  — an E.164 phone (finds-or-creates the 1:1 conversation), OR
    //   • `conversation_id` — send straight to an existing conversation. This
    //     is the ONLY way to reply in a GROUP (groups have no phone number).
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const conversationIdIn =
      typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
    if (!to && !conversationIdIn) {
      return fail('bad_request', "'to' or 'conversation_id' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;
    const templateMessageParams =
      template?.params && !Array.isArray(template.params)
        ? template.params
        : undefined;

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
    });

    // Find-or-create the conversation for this phone, then send. Both
    // steps share `SendMessageError`, so one catch maps the whole
    // pipeline to the envelope.
    // `channel_id` (optional) pins the send to a specific channel — e.g. reply
    // on the customer's own WhatsApp channel (waha) instead of the account
    // default, which could be the official Meta API. Without it the default
    // channel is used (loadDefaultChannel).
    const channelId =
      typeof body.channel_id === 'string' ? body.channel_id : null;

    // Resolve the target conversation. `conversation_id` sends straight to an
    // existing conversation (the group path); otherwise find-or-create by phone.
    let targetConversationId: string;
    let contactId: string | null = null;
    let contactCreated = false;
    if (conversationIdIn) {
      const conv = firstOrNull(
        await db
          .select({ id: conversations.id, contactId: conversations.contactId })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationIdIn),
              eq(conversations.accountId, ctx.accountId),
            ),
          )
          .limit(1),
      );
      if (!conv) return fail('not_found', 'conversation_id not found', 404);
      targetConversationId = conv.id;
      contactId = conv.contactId ?? null;
    } else {
      const resolved = await resolveConversationByPhone(
        ctx.accountId,
        to,
        typeof body.name === 'string' ? body.name : null,
        channelId,
      );
      targetConversationId = resolved.conversationId;
      contactId = resolved.contactId;
      contactCreated = resolved.contactCreated;
    }

    const result = await sendMessageToConversation(
      ctx.accountId,
      {
        conversationId: targetConversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      }
    );

    return ok(
      {
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
        conversation_id: targetConversationId,
        contact_id: contactId,
        contact_created: contactCreated,
      },
      201
    );
  } catch (err) {
    if (err instanceof SendMessageError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + WhatsApp config,
//   3. sends to Meta (with phone-variant retry + contact auto-fix),
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes an `accountId` (queries run on
// the shared Drizzle client and are always account-scoped — no RLS)
// and throws `SendMessageError` on failure. The callers own auth,
// rate-limiting, body parsing, and mapping the error to their
// respective response shapes (internal `{ error }` vs the v1
// envelope). Behaviour is identical to the original inline route —
// this is a straight extraction so the public endpoint can reuse it
// without duplicating ~250 lines of Meta plumbing.
// ============================================================

import { and, eq } from 'drizzle-orm';

import {
  db,
  contacts,
  conversations,
  flowRuns,
  messages,
  messageTemplates,
  whatsappConfig,
} from '@/db';
import { firstOrNull, firstOrThrow } from '@/db/helpers';
import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = [
  'text',
  'template',
  ...MEDIA_KINDS,
] as const;

/**
 * Typed failure with a machine `code` and a suggested HTTP `status`.
 * Callers map it to their own response shape (`toErrorResponse` for
 * the dashboard route, the v1 envelope for the public endpoint).
 */
export class SendMessageError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'SendMessageError';
    this.code = code;
    this.status = status;
  }
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  replyToMessageId?: string | null;
}

export interface SendMessageResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Meta's `wamid` for the delivered message. */
  whatsappMessageId: string;
}

/**
 * Validate the message-shape params (type, required content, caption
 * cap) independently of any DB state, throwing `SendMessageError` on a
 * bad payload. Exported so a caller can reject a malformed request
 * *before* it finds-or-creates a contact/conversation — otherwise an
 * invalid payload leaves an orphan empty conversation behind. The send
 * core calls this too, so validation can't be skipped.
 */
export function validateSendMessageParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  templateName?: string | null;
}): void {
  const { messageType, contentText, mediaUrl, templateName } = params;

  if (!messageType) {
    throw new SendMessageError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new SendMessageError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new SendMessageError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (messageType === 'template' && !templateName) {
    throw new SendMessageError(
      'bad_request',
      'template_name is required for template messages',
      400
    );
  }

  if (isMediaKind && !mediaUrl) {
    throw new SendMessageError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  // Meta caps media captions at 1024 chars (audio carries none).
  if (
    isMediaKind &&
    messageType !== 'audio' &&
    typeof contentText === 'string' &&
    contentText.length > 1024
  ) {
    throw new SendMessageError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

/**
 * Send a message in an existing conversation and persist it.
 *
 * Every query is filtered by `accountId` — there is no RLS on the
 * Drizzle client, so tenancy holds only through explicit scoping.
 */
export async function sendMessageToConversation(
  accountId: string,
  params: SendMessageParams
): Promise<SendMessageResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new SendMessageError(
      'bad_request',
      'conversation_id is required',
      400
    );
  }

  validateSendMessageParams({ messageType, contentText, mediaUrl, templateName });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Conversation + contact, account-scoped. A malformed UUID makes
  // Postgres throw where PostgREST used to return an error object —
  // both collapse to the same 404 the old code raised.
  let conversation: { id: string; contactId: string } | null = null;
  try {
    conversation = firstOrNull(
      await db
        .select({ id: conversations.id, contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, accountId)
          )
        )
        .limit(1)
    );
  } catch {
    conversation = null;
  }

  if (!conversation) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }

  const contact = firstOrNull(
    await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(eq(contacts.id, conversation.contactId))
      .limit(1)
  );
  if (!contact?.phone) {
    throw new SendMessageError(
      'bad_request',
      'Contact phone number not found',
      400
    );
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new SendMessageError(
      'bad_request',
      'Invalid phone number format',
      400
    );
  }

  // WhatsApp config, account-scoped.
  const config = firstOrNull(
    await db
      .select()
      .from(whatsappConfig)
      .where(eq(whatsappConfig.accountId, accountId))
      .limit(1)
  );

  if (!config) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please set up your WhatsApp integration first.',
      400
    );
  }

  const accessToken = decrypt(config.accessToken);

  // Self-heal legacy CBC ciphertexts. Fire-and-forget; idempotent.
  if (isLegacyFormat(config.accessToken)) {
    void db
      .update(whatsappConfig)
      .set({ accessToken: encrypt(accessToken) })
      .where(eq(whatsappConfig.id, config.id))
      .then(
        () => {},
        (error: unknown) => {
          console.warn(
            '[send-message] access_token GCM upgrade failed:',
            error instanceof Error ? error.message : error
          );
        }
      );
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  if (replyToMessageId) {
    let parent: { messageId: string | null } | null = null;
    try {
      parent = firstOrNull(
        await db
          .select({ messageId: messages.messageId })
          .from(messages)
          .where(
            and(
              eq(messages.id, replyToMessageId),
              eq(messages.conversationId, conversationId)
            )
          )
          .limit(1)
      );
    } catch {
      parent = null;
    }

    if (!parent) {
      throw new SendMessageError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.messageId) {
      console.warn(
        '[send-message] reply target has no Meta message_id; sending without context'
      );
    } else {
      contextMessageId = parent.messageId;
    }
  }

  // Template row (for header + button components). isMessageTemplate
  // guards against a malformed local row crashing the send-builder.
  // Selected with snake_case aliases so the row matches the public
  // `MessageTemplate` shape the send-builder expects.
  let templateRow: MessageTemplate | null = null;
  if (messageType === 'template' && templateName) {
    const data = firstOrNull(
      await db
        .select({
          id: messageTemplates.id,
          user_id: messageTemplates.userId,
          name: messageTemplates.name,
          category: messageTemplates.category,
          language: messageTemplates.language,
          header_type: messageTemplates.headerType,
          header_content: messageTemplates.headerContent,
          header_handle: messageTemplates.headerHandle,
          header_media_url: messageTemplates.headerMediaUrl,
          body_text: messageTemplates.bodyText,
          footer_text: messageTemplates.footerText,
          buttons: messageTemplates.buttons,
          sample_values: messageTemplates.sampleValues,
          status: messageTemplates.status,
          meta_template_id: messageTemplates.metaTemplateId,
          rejection_reason: messageTemplates.rejectionReason,
          quality_score: messageTemplates.qualityScore,
          submission_error: messageTemplates.submissionError,
          last_submitted_at: messageTemplates.lastSubmittedAt,
          created_at: messageTemplates.createdAt,
        })
        .from(messageTemplates)
        .where(
          and(
            eq(messageTemplates.accountId, accountId),
            eq(messageTemplates.name, templateName),
            eq(messageTemplates.language, templateLanguage || 'en_US')
          )
        )
        .limit(1)
    );
    if (data && !isMessageTemplate(data)) {
      throw new SendMessageError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.',
        500
      );
    }
    templateRow = (data as MessageTemplate | null) ?? null;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      const result = await sendTemplateMessage({
        phoneNumberId: config.phoneNumberId,
        accessToken,
        to: phone,
        templateName: templateName!,
        language: templateLanguage || 'en_US',
        template: templateRow ?? undefined,
        messageParams: templateMessageParams ?? undefined,
        params: templateParams || [],
        contextMessageId,
      });
      return result.messageId;
    }
    if (isMediaKind) {
      const result = await sendMediaMessage({
        phoneNumberId: config.phoneNumberId,
        accessToken,
        to: phone,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        contextMessageId,
      });
      return result.messageId;
    }
    const result = await sendTextMessage({
      phoneNumberId: config.phoneNumberId,
      accessToken,
      to: phone,
      text: contentText!,
      contextMessageId,
    });
    return result.messageId;
  };

  // Send via Meta — retry across phone-number variants if Meta rejects
  // with "recipient not in allowed list"; persist a working variant
  // back to the contact so the next send goes straight through.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants = phoneVariants(sanitizedPhone);
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isRecipientNotAllowedError(message)) {
          throw err;
        }
        lastError = err;
        console.warn(
          `[send-message] variant "${variant}" rejected by Meta, trying next…`
        );
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Unknown Meta API error';
    console.error('[send-message] Meta send failed for all variants:', message);
    throw new SendMessageError('meta_error', `Meta API error: ${message}`, 502);
  }

  if (workingPhone !== sanitizedPhone) {
    console.log(
      `[send-message] Auto-corrected contact phone: ${sanitizedPhone} → ${workingPhone}`
    );
    await db
      .update(contacts)
      .set({ phone: workingPhone })
      .where(eq(contacts.id, contact.id));
  }

  // Persist the sent message.
  let messageRecord: { id: string };
  try {
    messageRecord = firstOrThrow(
      await db
        .insert(messages)
        .values({
          conversationId,
          senderType: 'agent',
          contentType: messageType,
          contentText: contentText || null,
          mediaUrl: mediaUrl || null,
          templateName: templateName || null,
          messageId: waMessageId,
          status: 'sent',
          replyToMessageId: replyToMessageId || null,
        })
        .returning({ id: messages.id })
    );
  } catch (err) {
    console.error('[send-message] error inserting sent message:', err);
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new SendMessageError(
      'db_error',
      `Message sent to Meta but failed to save to DB: ${message}`,
      500
    );
  }

  await db
    .update(conversations)
    .set({
      lastMessageText: contentText || `[${messageType}]`,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(conversations.id, conversationId));

  // Pause any active Flow run for this contact — the agent stepping in
  // is the strongest "yield, human is here" signal. Best-effort.
  try {
    await db
      .update(flowRuns)
      .set({
        status: 'paused_by_agent',
        endedAt: new Date().toISOString(),
        endReason: 'agent_replied',
      })
      .where(
        and(
          eq(flowRuns.accountId, accountId),
          eq(flowRuns.contactId, contact.id),
          eq(flowRuns.status, 'active')
        )
      );
  } catch (err) {
    console.error(
      '[flows] pause-on-agent-send failed:',
      err instanceof Error ? err.message : err
    );
  }

  return { messageId: messageRecord.id, whatsappMessageId: waMessageId };
}

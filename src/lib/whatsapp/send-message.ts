// ============================================================
// Outbound message send — the core that both the dashboard's
// `/api/whatsapp/send` route and the public `/api/v1/messages`
// endpoint call.
//
// Given a conversation and message params, this:
//   1. validates the params for the message type,
//   2. loads the conversation + contact + its channel,
//   3. dispatches through the channel's provider (Phase 4 registry) —
//      Meta / WAHA / Evolution / EvoGo — never a hard-coded transport,
//   4. persists the message + updates the conversation,
//   5. pauses any active Flow run for the contact (agent stepped in).
//
// It is transport-agnostic: it takes an `accountId` (queries run on
// the shared Drizzle client and are always account-scoped — no RLS)
// and throws `SendMessageError` on failure. The callers own auth,
// rate-limiting, body parsing, and mapping the error to their
// respective response shapes (internal `{ error }` vs the v1
// envelope).
//
// Provider dispatch (Phase 4, wave 3A): the conversation carries a
// `channel_id`; we load that channel (already-decrypted ChannelCtx) and
// resolve its provider via getProvider(). A capability check runs BEFORE
// the send so a template/interactive on a non-Meta channel fails with a
// clean 422 rather than a cryptic upstream error. The phone-variant retry
// (Meta error #131030) is Meta-specific and gated on provider.id==='meta';
// other providers resolve their own chatId (WAHA) or don't need it.
// ============================================================

import { and, eq } from 'drizzle-orm';

import {
  db,
  contacts,
  conversations,
  flowRuns,
  messages,
  messageTemplates,
  monitoredGroups,
  groupParticipantNames,
} from '@/db';
import {
  groupJidDigits,
  buildOutboundGroupMentions,
} from '@/lib/whatsapp/group';
import { firstOrNull, firstOrThrow } from '@/db/helpers';
import { loadChannel, loadDefaultChannel } from '@/lib/channels/channels';
import { getProvider } from '@/lib/channels/registry';
import type { OutboundMedia, ChannelCtx } from '@/lib/channels/provider';
import type { MediaKind } from '@/lib/whatsapp/meta-api';
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

/**
 * Turn a raw provider send error (WAHA/gows gRPC blobs) into a friendly
 * pt-BR message for the operator's toast. The gows layer surfaces WhatsApp
 * server rejections as `server returned error <N>` — the raw JSON/stack is
 * useless to an atendente. Known throttle/reputation codes get a clear
 * "aguarde e reenvie"; anything unmapped falls back to the raw. Felipe (cema)
 * hit 463 mid-shift and saw the raw gRPC dump.
 */
export function friendlySendError(raw: string): string | null {
  const m = raw.toLowerCase();
  if (/error 463|"?463"?/.test(m)) {
    return 'O WhatsApp recusou o envio agora (limite ou reputação do número). Aguarde alguns minutos e tente novamente.';
  }
  if (/error 479|rate|too many|flood/.test(m)) {
    return 'Muitas mensagens em pouco tempo — o WhatsApp está limitando este número. Aguarde um pouco e reenvie.';
  }
  if (/not.*(on|registered).*whatsapp|não.*whatsapp|invalid.*(number|jid)|not-?found/.test(m)) {
    return 'Este número não parece estar no WhatsApp.';
  }
  if (/timeout|timed out|deadline/.test(m)) {
    return 'O envio demorou demais e não foi confirmado. Verifique a conexão do canal e tente de novo.';
  }
  return null;
}

export interface SendMessageParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  /** Original MIME type (ex.: application/pdf). Sem isso o documento sai como
   *  octet-stream e o celular não abre. */
  mimetype?: string | null;
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Legacy positional body params (only used if messageParams.body unset). */
  templateParams?: string[];
  /** Structured template params (header/body/buttons). */
  templateMessageParams?: unknown;
  replyToMessageId?: string | null;
  /** Assunto do e-mail (canais de e-mail). Ignorado pelos outros canais. */
  subject?: string | null;
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
    mimetype,
    templateName,
    templateLanguage,
    templateParams,
    templateMessageParams,
    replyToMessageId,
    subject,
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
  let conversation: {
    id: string;
    contactId: string;
    channelId: string | null;
  } | null = null;
  try {
    conversation = firstOrNull(
      await db
        .select({
          id: conversations.id,
          contactId: conversations.contactId,
          channelId: conversations.channelId,
        })
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
      .select({
        id: contacts.id,
        phone: contacts.phone,
        isGroup: contacts.isGroup,
        externalId: contacts.externalId,
        email: contacts.email,
      })
      .from(contacts)
      .where(eq(contacts.id, conversation.contactId))
      .limit(1)
  );
  if (!contact) {
    throw new SendMessageError('bad_request', 'Contact not found', 400);
  }

  // Resolve the conversation's channel FIRST — um e-mail entrega por
  // contacts.email e NÃO usa telefone, então as travas de telefone abaixo só
  // valem pra canais NÃO-e-mail. Credentials chegam já-descriptografadas no
  // ChannelCtx; prefere o channel_id da conversa, cai no default (legado).
  const channel = conversation.channelId
    ? await loadChannel(conversation.channelId)
    : await loadDefaultChannel(accountId);

  if (!channel) {
    throw new SendMessageError(
      'whatsapp_not_configured',
      'WhatsApp not configured. Please connect a channel first.',
      400
    );
  }
  // Tenancy guard: a conversation's channel_id must belong to the same
  // account (defense-in-depth — there is no RLS on the Drizzle client).
  if (channel.accountId !== accountId) {
    throw new SendMessageError('not_found', 'Conversation not found', 404);
  }
  const isEmailChannel =
    channel.provider === 'email' || channel.provider === 'gmail';

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  // Canal de e-mail com contato que tem e-mail dispensa telefone. Os demais
  // canais (WhatsApp/IG/Messenger) mantêm as travas: exige telefone OU external_id
  // (IGSID), e telefone em E.164 (grupo/external_id passam por serem casos à parte).
  if (!(isEmailChannel && contact.email)) {
    if (!contact.phone && !contact.externalId) {
      throw new SendMessageError(
        'bad_request',
        'Contact phone number not found',
        400
      );
    }
    if (!contact.isGroup && !contact.externalId && !isValidE164(sanitizedPhone)) {
      throw new SendMessageError(
        'bad_request',
        'Invalid phone number format',
        400
      );
    }
  }

  const provider = getProvider(channel.provider);

  // For a GROUP, the provider must receive the FULL group jid. contact.phone is
  // the digits only, which loses the hyphen of a legacy `<creator>-<ts>` jid
  // (e.g. 556792539584-1481125514@g.us) — sending to the reconstructed
  // hyphen-less id makes WAHA hang and abort. The intact jid lives in
  // monitored_groups.group_jid; look it up by matching digits.
  let providerTarget = sanitizedPhone;
  if (isEmailChannel && contact.email) {
    // E-mail: o destinatário é SEMPRE o e-mail do contato — mesmo que o lead
    // tenha entrado por outro canal (external_id pode ser um id de WhatsApp/IG).
    // Isso permite uma conversa de e-mail no MESMO contato (cadência multicanal).
    providerTarget = contact.email;
  } else if (contact.externalId) {
    // Instagram: o alvo do provider é o IGSID (não telefone).
    providerTarget = contact.externalId;
  } else if (contact.isGroup) {
    const wantedDigits = contact.phone.replace(/\D/g, '');
    const monitored = await db
      .select({ jid: monitoredGroups.groupJid })
      .from(monitoredGroups)
      .where(eq(monitoredGroups.channelId, channel.id));
    const match = monitored.find(
      (m) => groupJidDigits(m.jid) === wantedDigits,
    );
    const jid = match?.jid || wantedDigits;
    providerTarget = /@g\.us$/i.test(jid) ? jid : `${jid}@g.us`;
  }

  // Capability gate — BEFORE sending. Reject an operation the channel's
  // provider structurally can't do with a clean 422 rather than letting it
  // fail with a cryptic upstream error deep in the adapter.
  if (messageType === 'template' && !provider.capabilities.templates) {
    throw new SendMessageError(
      'unsupported',
      'Templates só no canal oficial (Meta).',
      422
    );
  }

  // Resolve the reply target to its Meta message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let contextMessageId: string | undefined;
  let contextFromMe = false;
  if (replyToMessageId) {
    let parent: { messageId: string | null; senderType: string } | null = null;
    try {
      parent = firstOrNull(
        await db
          .select({
            messageId: messages.messageId,
            senderType: messages.senderType,
          })
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
      // WAHA needs to know if the quoted message was ours to rebuild reply_to.
      contextFromMe =
        parent.senderType === 'agent' || parent.senderType === 'bot';
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

  // Group @mentions: when the operator typed "@Name" in a group text, resolve
  // it to a real WhatsApp mention. `waText` is what goes to WhatsApp (@<user>
  // tokens); the CRM keeps the original readable `contentText`. Only for group
  // text with an "@" — never a heavy round-trip otherwise.
  let waText = contentText;
  let mentionJids: string[] = [];
  if (
    contact.isGroup &&
    messageType === 'text' &&
    contentText &&
    contentText.includes('@')
  ) {
    try {
      const resolved = await resolveOutboundGroupMentions(
        accountId,
        channel,
        providerTarget,
        contentText,
      );
      waText = resolved.text;
      mentionJids = resolved.mentions;
    } catch (err) {
      console.error('[send-message] group mention resolve failed:', err);
    }
  }

  // Dispatch one send attempt through the resolved provider. Returns the
  // provider-side message id. Media/text/template all route through the
  // WhatsAppProvider interface — the adapter owns the transport specifics.
  const attempt = async (phone: string): Promise<string> => {
    if (messageType === 'template') {
      if (!provider.sendTemplate) {
        throw new SendMessageError(
          'unsupported',
          'Templates só no canal oficial (Meta).',
          422
        );
      }
      const result = await provider.sendTemplate(channel, phone, {
        name: templateName!,
        language: templateLanguage || 'en_US',
        // The Meta adapter narrows this back into template/messageParams/body.
        params: {
          template: templateRow ?? undefined,
          messageParams: templateMessageParams ?? undefined,
          body: templateParams || [],
        },
      });
      return result.externalMessageId;
    }
    if (isMediaKind) {
      const media: OutboundMedia = {
        kind: messageType as MediaKind,
        // Meta sends media by public link (the MinIO URL); non-official
        // providers download this URL → base64 inside their adapter.
        url: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        mimetype: mimetype || undefined,
      };
      const result = await provider.sendMedia(channel, phone, media);
      return result.externalMessageId;
    }
    const result = await provider.sendText(channel, phone, waText!, {
      contextExternalId: contextMessageId,
      contextFromMe,
      mentions: mentionJids.length ? mentionJids : undefined,
      subject: subject || undefined,
    });
    return result.externalMessageId;
  };

  // Send via the provider. The phone-variant retry (Meta error #131030,
  // "recipient not in allowed list") is Meta-specific — other providers
  // resolve their own chatId (WAHA's check-exists) or don't need it, so we
  // only iterate variants for Meta and hand every other provider the
  // sanitized number once.
  let waMessageId = '';
  let workingPhone = sanitizedPhone;
  try {
    const variants =
      provider.id === 'meta'
        ? phoneVariants(providerTarget)
        : [providerTarget];
    let lastError: unknown = null;

    for (const variant of variants) {
      try {
        waMessageId = await attempt(variant);
        workingPhone = variant;
        lastError = null;
        break;
      } catch (err) {
        // A capability/validation SendMessageError should surface as-is,
        // never be swallowed by the variant retry.
        if (err instanceof SendMessageError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (provider.id !== 'meta' || !isRecipientNotAllowedError(message)) {
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
    if (err instanceof SendMessageError) throw err;
    const message =
      err instanceof Error ? err.message : 'Unknown provider error';
    console.error(
      `[send-message] ${provider.id} send failed:`,
      message
    );
    // Show the atendente a clean message; keep the raw in the server log above.
    const friendly = friendlySendError(message);
    throw new SendMessageError(
      'send_error',
      friendly ?? `${provider.id} send error: ${message}`,
      502
    );
  }

  // The 9th-digit auto-correct is a 1:1 (Meta) thing. NEVER for a group nem para
  // Instagram (workingPhone é o IGSID/jid, não um telefone — gravá-lo em
  // contacts.phone corromperia a chave).
  if (!contact.isGroup && !contact.externalId && workingPhone !== sanitizedPhone) {
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

/**
 * Resolve the "@Name" tokens an operator typed in a GROUP text into real
 * WhatsApp mentions. Cross-references the display names we already learned
 * (`group_participant_names`, from people who posted) with the group's live
 * participant list (LID user-part + phone) so each name maps to the mention
 * user-part and jid WhatsApp expects IN THIS GROUP — the @lid form for a
 * lid-addressed group, else the phone. Returns the rewritten text (@<user>
 * tokens) + the jids to send in `mentions`. The participant list is only
 * fetched when a KNOWN name actually appears in the text (no heavy round-trip
 * otherwise). Best-effort: on any gap the token stays as typed.
 */
async function resolveOutboundGroupMentions(
  accountId: string,
  channel: ChannelCtx,
  groupJid: string,
  text: string,
): Promise<{ text: string; mentions: string[] }> {
  const nameRows = await db
    .select({
      waKey: groupParticipantNames.waKey,
      name: groupParticipantNames.name,
    })
    .from(groupParticipantNames)
    .where(eq(groupParticipantNames.accountId, accountId));
  // Only the names actually mentioned in the text matter.
  const relevant = nameRows.filter(
    (r) => r.name && text.includes(`@${r.name}`),
  );
  if (relevant.length === 0) return { text, mentions: [] };

  const provider = getProvider(channel.provider);
  const parts =
    typeof provider.listGroupParticipants === 'function'
      ? await provider.listGroupParticipants(channel, groupJid)
      : [];
  // Index participants by BOTH ids so a name's wa_key (LID user OR phone)
  // resolves to the same participant either way.
  const byKey = new Map<string, { lidUser?: string; phone?: string }>();
  for (const p of parts) {
    if (p.lidUser) byKey.set(p.lidUser, p);
    if (p.phone) byKey.set(p.phone, p);
  }

  const nameToUser: Record<string, string> = {};
  const jidByUser: Record<string, string> = {};
  for (const r of relevant) {
    const part = r.waKey ? byKey.get(r.waKey) : undefined;
    if (!part) continue;
    // Prefer the LID (a lid-addressed group mentions by @lid); else the phone.
    if (part.lidUser) {
      nameToUser[r.name as string] = part.lidUser;
      jidByUser[part.lidUser] = `${part.lidUser}@lid`;
    } else if (part.phone) {
      nameToUser[r.name as string] = part.phone;
      jidByUser[part.phone] = `${part.phone}@c.us`;
    }
  }
  return buildOutboundGroupMentions(text, nameToUser, jidByUser);
}

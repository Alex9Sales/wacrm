// ============================================================
// Agnostic inbound pipeline (Phase 4).
//
// `dispatchInboundMessage(channel, ev)` is the provider-agnostic core
// extracted from the Meta webhook's processMessage/findOrCreateContact/
// findOrCreateConversation. Every WhatsApp transport — Meta (wave 3) and
// the non-Meta webhooks (wave 3) — funnels its normalized inbound events
// through this one function so contact/conversation resolution, dedup,
// media handling, unread bumps, SSE, broadcast-reply flagging, and the
// flows/automations/AI dispatch all behave identically regardless of
// provider.
//
// What it does NOT do: parse raw webhook bodies (that's the provider's
// parseWebhook), verify signatures, or fetch inbound media that arrives
// without bytes — for WAHA/Evolution that fetch happens IN the provider
// (via fetchInboundMedia) BEFORE calling this, so here we only handle
// ev.media.base64 / ev.media.url that's already present.
// ============================================================

import { randomUUID } from 'crypto';
import { and, count, eq, gte, inArray, isNull } from 'drizzle-orm';

import { db, contacts, conversations, messages } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { publishEvent } from '@/lib/events/publish';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { transcribeInboundAudio } from '@/lib/ai/transcribe';
import { getAccountSettings } from '@/lib/settings/account-settings';
import { isWithinBusinessHours } from '@/lib/settings/business-hours';
import { engineSendText } from '@/lib/flows/meta-send';
import { maybeRecordCsat } from '@/lib/csat/csat';
import { routeNewConversation, rerouteByKeyword } from '@/lib/sectors/routing';
import { putObject, publicUrl } from '@/lib/storage/s3';
import { CALL_PERM_PREFIX } from '@/lib/inbox/call-log';
import { getProvider } from './registry';
import type { ChannelCtx, NormalizedInbound } from './provider';

/** Bucket for inbound media — public-read, same as the rest of Phase 3. */
const MEDIA_BUCKET = 'media';

/** Maps a NormalizedInbound.contentType to a messages.content_type value. */
const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);

export interface DispatchInboundResult {
  conversationId: string;
  contactId: string;
  /** True when this is the contact's first-ever customer-sent message. */
  isFirstInbound: boolean;
}

/**
 * Ingest one normalized inbound message for a channel. Idempotent on
 * `externalMessageId` (a replayed delivery is a no-op). Returns null only
 * when a fatal resolution error prevents persisting (contact/conversation
 * couldn't be created); duplicates return the existing conversation.
 */
export async function dispatchInboundMessage(
  channel: ChannelCtx,
  ev: NormalizedInbound,
): Promise<DispatchInboundResult | null> {
  const accountId = channel.accountId;
  // Sender-of-record for NOT NULL user_id FKs on inserts. Legacy webhook
  // used the config owner; channels carry no owner, so we attribute
  // auto-created rows to a stable synthetic — but contacts.user_id /
  // conversations.user_id are NOT NULL FKs to organization members. To
  // stay compatible with the existing schema we reuse the account's
  // creator via the contact's own userId when it already exists, and for
  // brand-new rows we need SOME member id. We resolve it lazily below.
  const senderPhone = ev.fromPhoneE164;

  // 1) Dedup by externalMessageId — skip if a message with that id already
  //    exists on THIS CHANNEL (messages have no account_id column, so we
  //    join through conversations). Scoped per channel, not per account:
  //    a replayed webhook always hits the same channel, but when BOTH sides
  //    of a chat are channels of the same account (e.g. two of the org's
  //    numbers talking), the same WhatsApp message id legitimately appears
  //    once per channel — account-wide dedupe silently dropped the second.
  if (ev.externalMessageId) {
    const dupe = firstOrNull(
      await db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id))
        .where(
          and(
            eq(messages.messageId, ev.externalMessageId),
            eq(conversations.accountId, accountId),
            eq(conversations.channelId, channel.id),
          ),
        )
        .limit(1),
    );
    if (dupe) {
      // Already ingested. Resolve the conversation so callers still get a
      // consistent return shape, but do nothing else.
      const existing = firstOrNull(
        await db
          .select({
            conversationId: messages.conversationId,
            contactId: conversations.contactId,
          })
          .from(messages)
          .innerJoin(
            conversations,
            eq(messages.conversationId, conversations.id),
          )
          .where(eq(messages.id, dupe.id))
          .limit(1),
      );
      if (existing) {
        return {
          conversationId: existing.conversationId,
          contactId: existing.contactId,
          isFirstInbound: false,
        };
      }
      return null;
    }
  }

  // `fromMe` = the operator answered from their OWN phone. On such echoes the
  // pushName is the OPERATOR's WhatsApp name, NOT the contact's — using it
  // would rename every customer to the operator ("Alex Sales"). So only carry
  // the pushName for genuine incoming (customer) messages; fromMe passes no
  // name (a new contact falls back to its phone number).
  const isFromMe = ev.fromMe === true;

  // 2) Resolve / create contact by E.164 (shared dedupe helper).
  const contactOutcome = await findOrCreateContact(
    accountId,
    senderPhone,
    isFromMe ? '' : ev.pushName ?? '',
  );
  if (!contactOutcome) return null;
  const contactId = contactOutcome.contact.id;

  // 2b) Best-effort avatar backfill. For a GENUINE incoming (customer)
  //     message from a contact that has no avatar yet, pull the sender's
  //     WhatsApp profile photo, re-host it in MinIO, and set avatar_url.
  //     Skipped for fromMe (that's the operator's own phone) and when the
  //     contact already has an avatar (attempt-once). Fire-and-forget: it
  //     is NEVER awaited on the critical path and can never drop a message.
  if (!isFromMe && !contactOutcome.contact.avatarUrl) {
    void backfillContactAvatar(channel, contactId, senderPhone).catch((err) =>
      console.error('[inbound] avatar backfill dispatch failed:', err),
    );
  }

  // 3) Resolve / create conversation by (account, contact, channel.id).
  const convResult = await findOrCreateConversation(
    accountId,
    contactOutcome.contact.userId,
    contactId,
    channel.id,
  );
  if (!convResult) return null;
  const conversation = convResult.conversation;

  // Emit conversation.created as soon as the thread opens.
  if (convResult.created) {
    await dispatchWebhookEvent(accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactId,
    });
    await publishEvent(accountId, {
      type: 'conversation.created',
      conversationId: conversation.id,
    });
  }

  // 4) Media: if base64/url present, upload to MinIO → stable public URL.
  //    Providers without inbound media (EvoGo) never set ev.media, so a
  //    text placeholder falls out naturally from contentText below.
  let mediaUrl: string | null = null;
  if (ev.media && (ev.media.base64 || ev.media.url)) {
    mediaUrl = await storeInboundMedia(ev.media);
  }

  // Map contentType to an allowed messages.content_type.
  const contentType = ALLOWED_CONTENT_TYPES.has(ev.contentType)
    ? ev.contentType
    : 'text';

  // Audio transcription (opt-in). Inbound voice notes → text via the
  // account's OpenAI key, computed here so the message row lands with the
  // transcript already attached. Best-effort: null on any failure.
  let transcription: string | null = null;
  if (contentType === 'audio' && ev.media && !isFromMe) {
    try {
      const { audioTranscriptionEnabled } = await getAccountSettings(accountId);
      if (audioTranscriptionEnabled) {
        transcription = await transcribeInboundAudio(accountId, ev.media);
      }
    } catch (err) {
      console.error('[inbound] transcription failed:', err);
    }
  }

  // Fallback text so an inbound with no body still renders legibly (e.g.
  // EvoGo media placeholder, unsupported types). WhatsApp "view once" is
  // delivered by WAHA WITHOUT the media, so give it a clear label instead
  // of the raw "[text]" placeholder.
  const isViewOnce = ev.viewOnce ?? ev.media?.viewOnce ?? false;
  const contentText =
    ev.contentText ??
    (ev.media
      ? `[${ev.media.kind}]`
      : isViewOnce
        ? '🔒 Visualização única'
        : `[${ev.contentType}]`);

  // Is this the contact's first-ever inbound in this conversation?
  let priorCustomerMsgCount = 0;
  try {
    const [counted] = await db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          eq(messages.senderType, 'customer'),
        ),
      );
    priorCustomerMsgCount = counted?.n ?? 0;
  } catch (err) {
    console.error('[inbound] Error counting prior customer messages:', err);
  }
  const isFirstInbound = priorCustomerMsgCount === 0;

  // 5) Insert the message (agent bubble when fromMe, else customer). A fromMe
  // echo is the operator's own outgoing message (see isFromMe above): render
  // it as an agent bubble, don't bump unread, and skip every customer-triggered
  // side effect below. Messages the CRM itself sent are deduped upstream by
  // external id, so this only covers phone-typed replies.
  try {
    await db.insert(messages).values({
      conversationId: conversation.id,
      senderType: isFromMe ? 'agent' : 'customer',
      contentType,
      contentText,
      mediaUrl,
      transcription,
      viewOnce: isViewOnce,
      messageId: ev.externalMessageId || null,
      status: isFromMe ? 'sent' : 'delivered',
      createdAt: new Date().toISOString(),
      interactiveReplyId: ev.interactiveReplyId ?? null,
    });
  } catch (msgError) {
    console.error('[inbound] Error inserting message:', msgError);
    return null;
  }

  // Realtime ping. `fromMe` lets the notification listener skip the operator's
  // own phone-typed echoes (unread refetch still runs, but no sound/pop-up).
  // Call-permission replies are system-ish — refresh the thread but don't ring.
  const silent = contentText.startsWith(CALL_PERM_PREFIX);
  await publishEvent(accountId, {
    type: 'message.received',
    conversationId: conversation.id,
    fromMe: isFromMe || silent,
  });

  // Bump last message; unread only for genuinely incoming (customer) messages.
  try {
    await db
      .update(conversations)
      .set({
        lastMessageText: contentText,
        lastMessageAt: new Date().toISOString(),
        unreadCount: isFromMe
          ? conversation.unreadCount || 0
          : (conversation.unreadCount || 0) + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(conversations.id, conversation.id));
  } catch (convError) {
    console.error('[inbound] Error updating conversation:', convError);
  }

  // Phase 2: route this customer message to a sector.
  if (!isFromMe) {
    if (convResult.created) {
      // Brand-new conversation: keyword on the first message → channel's
      // default sector → general queue; auto-assign when the sector does.
      const routed = await routeNewConversation({
        accountId,
        channelId: conversation.channelId ?? channel.id,
        conversationId: conversation.id,
        firstText: ev.contentText ?? contentText,
      });
      if (routed.sectorId || routed.assignedAgentId) {
        await publishEvent(accountId, {
          type: 'message.received',
          conversationId: conversation.id,
        });
      }
    } else if (conversation.sectorId == null) {
      // Existing conversation still in the GENERAL QUEUE: a keyword in a later
      // message can move it to a sector — but ONLY while it's unattended (no
      // HUMAN agent has replied yet). A 'bot'/AI auto-reply doesn't count, so
      // an AI triaging the queue can still hand off; but the moment a real
      // agent answers (from the CRM or their own phone → sender_type 'agent'),
      // the thread is locked and keywords never yank it away.
      try {
        const [agentMsgs] = await db
          .select({ n: count() })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.senderType, 'agent'),
            ),
          );
        if ((agentMsgs?.n ?? 0) === 0) {
          const routed = await rerouteByKeyword({
            accountId,
            conversationId: conversation.id,
            text: ev.contentText ?? contentText,
          });
          if (routed.sectorId) {
            await publishEvent(accountId, {
              type: 'message.received',
              conversationId: conversation.id,
            });
          }
        }
      } catch (err) {
        console.error('[inbound] keyword reroute failed:', err);
      }
    }
  }

  // A fromMe echo is the operator's own outgoing message — stop here. No
  // broadcast-reply flag, no flows/automations/AI, no inbound webhook.
  if (isFromMe) {
    return { conversationId: conversation.id, contactId, isFirstInbound: false };
  }

  // CSAT: if this conversation is awaiting a satisfaction rating, a 1–5 reply
  // is recorded as the score (and thanked) instead of flowing to bots/agents.
  const csatHandled = await maybeRecordCsat(
    accountId,
    {
      id: conversation.id,
      contactId,
      userId: contactOutcome.contact.userId,
      assignedAgentId: conversation.assignedAgentId ?? null,
      csatPendingAt: conversation.csatPendingAt ?? null,
      csatCommentPending: conversation.csatCommentPending ?? null,
    },
    ev.contentText ?? '',
  );
  if (csatHandled) {
    await dispatchWebhookEvent(accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactId,
      whatsapp_message_id: ev.externalMessageId,
      content_type: contentType,
      text: ev.contentText ?? null,
    });
    return { conversationId: conversation.id, contactId, isFirstInbound };
  }

  // Re-open a closed conversation when the customer comes back with a real
  // message (not a CSAT rating, handled above). The SAME thread resurfaces —
  // full history + the agent who handled it are preserved; only the status
  // flips back to open so it isn't lost in the "Fechada" filter.
  if (conversation.status === 'closed') {
    try {
      await db
        .update(conversations)
        .set({ status: 'open', updatedAt: new Date().toISOString() })
        .where(eq(conversations.id, conversation.id));
    } catch (err) {
      console.error('[inbound] reopen on new message failed:', err);
    }
  }

  // Flag broadcast reply, if any.
  await flagBroadcastReplyIfAny(accountId, contactId);

  // Out-of-hours auto-reply. When the customer writes outside business hours
  // (and we haven't already sent a closed-notice recently), send the account's
  // configured message and skip the AI auto-reply below — a human isn't
  // available, so the closed notice stands in for it.
  const outOfHoursSent = await maybeSendOutOfHoursReply(
    accountId,
    conversation.id,
    contactId,
    contactOutcome.contact.userId,
  );

  // ---- Flows / automations / AI dispatch (identical to the Meta webhook) ----
  const inboundText = ev.contentText ?? '';
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: contactOutcome.contact.userId,
    contactId,
    conversationId: conversation.id,
    message: ev.interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: ev.interactiveReplyId,
          reply_title: ev.contentText ?? '',
          meta_message_id: ev.externalMessageId,
        }
      : {
          kind: 'text',
          text: inboundText,
          meta_message_id: ev.externalMessageId,
        },
    isFirstInboundMessage: isFirstInbound,
  });
  const flowConsumed = flowResult.consumed;

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInbound) automationTriggers.unshift('first_inbound_message');
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err));
  }

  // AI auto-reply — plain-text, not consumed by a flow, and not already
  // handled by the out-of-hours notice.
  if (!flowConsumed && !outOfHoursSent && !ev.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId,
      configOwnerUserId: contactOutcome.contact.userId,
    });
  }

  // message.received webhook (public API).
  await dispatchWebhookEvent(accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactId,
    whatsapp_message_id: ev.externalMessageId,
    content_type: contentType,
    text: ev.contentText ?? null,
  });

  return { conversationId: conversation.id, contactId, isFirstInbound };
}

/**
 * If business hours are enabled and `now` is outside them, send the account's
 * out-of-hours message (as a bot reply) — deduped so it fires at most once per
 * closed period per conversation (skipped when any agent/bot message already
 * went out in the last 6h). Returns true when a notice was sent. Best-effort:
 * any failure returns false and never blocks the inbound.
 */
async function maybeSendOutOfHoursReply(
  accountId: string,
  conversationId: string,
  contactId: string,
  userId: string,
): Promise<boolean> {
  try {
    const settings = await getAccountSettings(accountId);
    if (!settings.businessHoursEnabled) return false;
    if (isWithinBusinessHours(settings)) return false;
    const message = settings.outOfHoursMessage?.trim();
    if (!message) return false;

    // Dedup: don't re-send if we already replied (agent OR bot) in the last 6h.
    const sixHoursAgo = new Date(Date.now() - 6 * 3_600_000).toISOString();
    const [recent] = await db
      .select({ n: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          inArray(messages.senderType, ['agent', 'bot']),
          gte(messages.createdAt, sixHoursAgo),
        ),
      );
    if ((recent?.n ?? 0) > 0) return false;

    await engineSendText({ accountId, userId, conversationId, contactId, text: message });
    return true;
  } catch (err) {
    console.error('[inbound] out-of-hours reply failed:', err);
    return false;
  }
}

/**
 * Download / decode inbound media and store it in MinIO, returning the
 * stable public URL. Best-effort: returns null on any failure so a media
 * hiccup never drops the whole inbound message.
 */
async function storeInboundMedia(media: NonNullable<NormalizedInbound['media']>): Promise<string | null> {
  try {
    let bytes: Buffer | null = null;
    if (media.base64) {
      // Tolerate a data: prefix if a provider ever includes one.
      const b64 = media.base64.includes(',')
        ? media.base64.slice(media.base64.indexOf(',') + 1)
        : media.base64;
      bytes = Buffer.from(b64, 'base64');
    } else if (media.url) {
      const res = await fetch(media.url);
      if (!res.ok) {
        console.error(
          `[inbound] media fetch failed: ${res.status} ${media.url}`,
        );
        return null;
      }
      bytes = Buffer.from(await res.arrayBuffer());
    }
    if (!bytes) return null;

    const ext = extensionFor(media.mimetype, media.filename);
    const key = `inbound/${randomUUID()}${ext}`;
    await putObject(
      MEDIA_BUCKET,
      key,
      bytes,
      media.mimetype || 'application/octet-stream',
    );
    return publicUrl(MEDIA_BUCKET, key);
  } catch (err) {
    console.error('[inbound] storeInboundMedia failed:', err);
    return null;
  }
}

/**
 * Best-effort backfill of a contact's WhatsApp profile photo into
 * contacts.avatar_url. Asks the channel's provider for the (short-lived,
 * cross-origin) CDN URL, downloads the bytes, re-hosts them in MinIO
 * (so the app serves a stable HTTPS URL via the media proxy — the raw
 * pps.whatsapp.net URL expires and can be http/cross-origin, so we never
 * store it directly), then sets avatar_url. Every step is guarded: a
 * profile-pic hiccup must never affect the inbound message that spawned
 * it (the caller runs this fire-and-forget).
 */
async function backfillContactAvatar(
  channel: ChannelCtx,
  contactId: string,
  phoneE164: string,
): Promise<void> {
  try {
    const provider = getProvider(channel.provider);
    // Optional method — providers that don't expose profile photos (Meta /
    // Evolution / EvoGo today) simply skip the backfill.
    if (typeof provider.fetchProfilePicture !== 'function') return;

    const pic = await provider.fetchProfilePicture(channel, phoneE164);
    if (!pic || !pic.url) return;

    // Download the CDN image bytes.
    const res = await fetch(pic.url);
    if (!res.ok) {
      console.error(
        `[inbound] avatar fetch failed: ${res.status} ${pic.url}`,
      );
      return;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0) return;
    const mimetype =
      res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';

    // Re-host in MinIO under an avatars/ key → stable public proxy URL.
    const ext = extensionFor(mimetype);
    const key = `avatars/${contactId}/${randomUUID()}${ext || '.jpg'}`;
    await putObject(MEDIA_BUCKET, key, bytes, mimetype);
    const url = publicUrl(MEDIA_BUCKET, key);

    // Only set avatar_url when it's still empty — avoids clobbering a value
    // a concurrent inbound (or a manual edit) may have set in the meantime,
    // and keeps this a one-time backfill.
    await db
      .update(contacts)
      .set({ avatarUrl: url, updatedAt: new Date().toISOString() })
      .where(and(eq(contacts.id, contactId), isNull(contacts.avatarUrl)));
  } catch (err) {
    console.error('[inbound] backfillContactAvatar failed:', err);
  }
}

/** Best-effort file extension from mimetype or filename. */
function extensionFor(mimetype?: string, filename?: string): string {
  if (filename && filename.includes('.')) {
    return filename.slice(filename.lastIndexOf('.'));
  }
  if (!mimetype) return '';
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
  };
  return map[mimetype] ?? '';
}

interface ContactOutcome {
  contact: {
    id: string;
    userId: string;
    name?: string | null;
    avatarUrl?: string | null;
  };
  wasCreated: boolean;
}

/**
 * Find or create a contact for `accountId` by phone. Mirrors the Meta
 * webhook's findOrCreateContact, reusing findExistingContact/phonesMatch
 * for the fuzzy lookup and the unique-violation race backstop.
 *
 * The NOT NULL contacts.user_id FK: for a brand-new contact we need a
 * member id. We reuse an existing contact's user_id when present; for the
 * very first contact in an account we fall back to the account's owner
 * member. Resolving that owner is the caller's responsibility in the Meta
 * path today; here we look it up so the pipeline stays self-contained.
 */
async function findOrCreateContact(
  accountId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existing = await findExistingContact(accountId, phone);
  if (existing) {
    if (name && name !== existing.name) {
      try {
        await db
          .update(contacts)
          .set({ name, updatedAt: new Date().toISOString() })
          .where(eq(contacts.id, existing.id));
      } catch (err) {
        console.error('[inbound] Error updating contact name:', err);
      }
    }
    return {
      contact: {
        id: existing.id,
        userId: String(existing.userId),
        name: existing.name,
        avatarUrl: (existing.avatarUrl ?? null) as string | null,
      },
      wasCreated: false,
    };
  }

  const ownerUserId = await resolveAccountOwnerUserId(accountId);
  if (!ownerUserId) {
    console.error(
      '[inbound] no member found for account; cannot create contact',
      accountId,
    );
    return null;
  }

  try {
    const created = firstOrNull(
      await db
        .insert(contacts)
        .values({
          accountId,
          userId: ownerUserId,
          phone,
          name: name || phone,
        })
        .returning(),
    );
    if (!created) {
      console.error('[inbound] Error creating contact: no row returned');
      return null;
    }
    return {
      contact: {
        id: created.id,
        userId: created.userId,
        name: created.name,
        avatarUrl: created.avatarUrl ?? null,
      },
      wasCreated: true,
    };
  } catch (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(accountId, phone);
      if (raced) {
        return {
          contact: {
            id: raced.id,
            userId: String(raced.userId),
            name: raced.name,
          },
          wasCreated: false,
        };
      }
    }
    console.error('[inbound] Error creating contact:', createError);
    return null;
  }
}

/**
 * Resolve a stable member user id to stamp on auto-created contact /
 * conversation rows (NOT NULL user_id FK). Prefers the account owner.
 */
async function resolveAccountOwnerUserId(
  accountId: string,
): Promise<string | null> {
  // Imported lazily to avoid a cyclic import at module load.
  const { member } = await import('@/db');
  const rows = await db
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(eq(member.organizationId, accountId));
  if (rows.length === 0) return null;
  const owner = rows.find((r) => r.role === 'owner');
  return (owner ?? rows[0]).userId;
}

/**
 * Find or create a conversation for (account, contact, channel). Mirrors
 * the Meta webhook but keys on channel_id too — one conversation per
 * (account, contact, channel).
 */
async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
  channelId: string,
) {
  let existing: typeof conversations.$inferSelect | null = null;
  try {
    existing = firstOrNull(
      await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, accountId),
            eq(conversations.contactId, contactId),
            eq(conversations.channelId, channelId),
          ),
        )
        .limit(1),
    );
  } catch (findError) {
    console.error('[inbound] Error finding conversation:', findError);
  }

  if (existing) return { conversation: existing, created: false };

  try {
    const created = firstOrNull(
      await db
        .insert(conversations)
        .values({
          accountId,
          userId,
          contactId,
          channelId,
        })
        .returning(),
    );
    if (!created) {
      console.error('[inbound] Error creating conversation: no row returned');
      return null;
    }
    return { conversation: created, created: true };
  } catch (createError) {
    // Lost a race on the (account, contact, channel) unique index —
    // re-resolve the winner instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = firstOrNull(
        await db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.accountId, accountId),
              eq(conversations.contactId, contactId),
              eq(conversations.channelId, channelId),
            ),
          )
          .limit(1),
      );
      if (raced) return { conversation: raced, created: false };
    }
    console.error('[inbound] Error creating conversation:', createError);
    return null;
  }
}

/**
 * If the inbound sender is on a still-unreplied broadcast recipient row,
 * flip it to `replied`. Best-effort — copied from the Meta webhook.
 */
async function flagBroadcastReplyIfAny(accountId: string, contactId: string) {
  try {
    const { broadcastRecipients, broadcasts } = await import('@/db');
    const { desc, inArray } = await import('drizzle-orm');
    const recs = await db
      .select({ id: broadcastRecipients.id })
      .from(broadcastRecipients)
      .innerJoin(broadcasts, eq(broadcastRecipients.broadcastId, broadcasts.id))
      .where(
        and(
          eq(broadcastRecipients.contactId, contactId),
          eq(broadcasts.accountId, accountId),
          inArray(broadcastRecipients.status, ['sent', 'delivered', 'read']),
        ),
      )
      .orderBy(desc(broadcastRecipients.createdAt))
      .limit(1);

    if (!recs || recs.length === 0) return;
    try {
      await db
        .update(broadcastRecipients)
        .set({ status: 'replied', repliedAt: new Date().toISOString() })
        .where(eq(broadcastRecipients.id, recs[0].id));
    } catch (updErr) {
      console.error('[inbound] Error marking broadcast recipient replied:', updErr);
    }
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny failed:', err);
  }
}

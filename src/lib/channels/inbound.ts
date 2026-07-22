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

import {
  db,
  contacts,
  conversations,
  messages,
  monitoredGroups,
  groupParticipantNames,
} from '@/db';
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
import {
  groupJidDigits,
  prefixGroupAuthor,
  resolveGroupMentions,
} from '@/lib/whatsapp/group';
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
  // A GROUP message follows a deliberately NARROW path (opt-in filtered, no
  // AI/flows/automations/routing) — its presence here routes it entirely away
  // from the 1:1 pipeline below. This is the single branch point; nothing
  // downstream ever sees ev.group.
  if (ev.group) {
    return ingestGroupMessage(channel, ev);
  }

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

  // Audio transcription (opt-in). Voice notes → text via the account's OpenAI
  // key, computed here so the message row lands with the transcript attached.
  // Covers BOTH directions: the customer's notes AND the operator's own audio
  // sent from their phone (fromMe echo) — Alex asked for sent audio too, so an
  // audio the operator recorded on the phone is legible in the thread. (Audio
  // recorded inside the CRM goes through the send path and its echo is
  // deduplicated, so it isn't transcribed here — that's a separate path.)
  // Best-effort: null on any failure.
  let transcription: string | null = null;
  if (contentType === 'audio' && ev.media) {
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
 * Ingest one message from a WhatsApp GROUP — the isolated path for Grupos
 * Fase 1 (etapa D). Deliberately NARROW vs the 1:1 pipeline: it resolves a
 * group "contact"/conversation and stores the message (author-prefixed) so the
 * agent can read/summarize the group via the API, and NOTHING else — no AI
 * auto-reply, no flows/automations, no sector routing, no CSAT, no out-of-hours
 * (a monitored group is watched, never auto-answered — auto-posting to a group
 * is a real ban risk, and the CRM is the "eyes+mouth", the agent is the brain).
 *
 * Opt-in: only groups the admin marked in `monitored_groups` are ingested;
 * everything else is dropped exactly as before. Idempotent on
 * externalMessageId (per channel).
 */
async function ingestGroupMessage(
  channel: ChannelCtx,
  ev: NormalizedInbound,
): Promise<DispatchInboundResult | null> {
  const group = ev.group;
  if (!group) return null;
  const accountId = channel.accountId;

  // 1) OPT-IN gate. Match by jid digits so a bare-vs-@g.us mismatch between the
  //    picker (GET /groups) and inbound doesn't miss a monitored group.
  const wantedDigits = groupJidDigits(group.jid);
  if (!wantedDigits) return null;
  let monitoredRow: { groupJid: string; groupName: string | null } | undefined;
  try {
    const rows = await db
      .select({
        groupJid: monitoredGroups.groupJid,
        groupName: monitoredGroups.groupName,
      })
      .from(monitoredGroups)
      .where(eq(monitoredGroups.channelId, channel.id));
    monitoredRow = rows.find(
      (r) => groupJidDigits(r.groupJid) === wantedDigits,
    );
  } catch (err) {
    console.error('[inbound] group monitored lookup failed:', err);
    return null;
  }
  if (!monitoredRow) return null; // not opt-in → drop (unchanged v1 behaviour)

  // 2) Dedup by externalMessageId on THIS channel (same rule as the 1:1 path).
  if (ev.externalMessageId) {
    const dupe = firstOrNull(
      await db
        .select({ conversationId: messages.conversationId })
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
      return {
        conversationId: dupe.conversationId,
        contactId: '',
        isFirstInbound: false,
      };
    }
  }

  // 3) Resolve/create the group "contact" (phone = jid digits, is_group=true).
  //    The 18-digit key can never collide with an E.164 phone (max 15 digits).
  const groupName =
    group.name ||
    monitoredRow.groupName ||
    `Grupo ${wantedDigits.slice(-6)}`;
  const contactOutcome = await findOrCreateContact(
    accountId,
    wantedDigits,
    groupName,
    { isGroup: true },
  );
  if (!contactOutcome) return null;
  const contactId = contactOutcome.contact.id;

  // 3b) Best-effort group photo backfill — same pipeline as the 1:1 avatar,
  //     keyed by the group jid (@g.us) instead of a phone. Runs whenever the
  //     group has no avatar yet (attempt-once per null), regardless of fromMe
  //     since the group photo is independent of who authored the message.
  //     Fire-and-forget: NEVER awaited on the critical path.
  if (!contactOutcome.contact.avatarUrl) {
    void backfillGroupAvatar(channel, contactId, group.jid).catch((err) =>
      console.error('[inbound] group avatar backfill dispatch failed:', err),
    );
  }

  // 4) Resolve/create the single group conversation for this channel.
  const convResult = await findOrCreateConversation(
    accountId,
    contactOutcome.contact.userId,
    contactId,
    channel.id,
  );
  if (!convResult) return null;
  const conversation = convResult.conversation;
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

  // 5) Media (reuse the same MinIO upload path).
  let mediaUrl: string | null = null;
  if (ev.media && (ev.media.base64 || ev.media.url)) {
    mediaUrl = await storeInboundMedia(ev.media);
  }

  const contentType = ALLOWED_CONTENT_TYPES.has(ev.contentType)
    ? ev.contentType
    : 'text';
  const isFromMe = ev.fromMe === true;
  let baseText =
    ev.contentText ?? (ev.media ? `[${ev.media.kind}]` : `[${ev.contentType}]`);

  // Register the author's pushName against their LID + phone so later @mentions
  // of them resolve to the name. Best-effort — never blocks the message.
  if (group.authorName) {
    await registerParticipantName(
      accountId,
      [group.authorLid, group.authorPhone],
      group.authorName,
    );
  }
  // Rewrite "@<number>" mentions in the body to the known display name, the way
  // WhatsApp shows them. Unknown participants stay as the number.
  if (group.mentions?.length) {
    const nameByUser = await lookupParticipantNames(accountId, group.mentions);
    baseText = resolveGroupMentions(baseText, group.mentions, nameByUser);
  }

  // Prefix the author so the single group thread stays legible. A fromMe echo
  // is OUR own post in the group → agent bubble, no prefix.
  const contentText = isFromMe
    ? baseText
    : prefixGroupAuthor(group.authorName ?? '', baseText);

  // 6) Insert. No transcription/AI/flows — a group is watched, not answered.
  try {
    await db.insert(messages).values({
      conversationId: conversation.id,
      senderType: isFromMe ? 'agent' : 'customer',
      contentType,
      contentText,
      mediaUrl,
      viewOnce: ev.viewOnce ?? ev.media?.viewOnce ?? false,
      messageId: ev.externalMessageId || null,
      status: isFromMe ? 'sent' : 'delivered',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[inbound] Error inserting group message:', err);
    return null;
  }

  // 7) Bump last message. Publish with fromMe=true so the inbox list refetches
  //    but the NotificationListener never RINGS for ordinary group chatter.
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
  } catch (err) {
    console.error('[inbound] Error updating group conversation:', err);
  }

  await publishEvent(accountId, {
    type: 'message.received',
    conversationId: conversation.id,
    fromMe: true,
  });

  return { conversationId: conversation.id, contactId, isFirstInbound: false };
}

/**
 * Record a group participant's display name against each of their wa_keys (LID
 * user-part + phone digits) so later @mentions of them resolve to the name.
 * Best-effort: any failure is swallowed — it must never block a group message.
 */
async function registerParticipantName(
  accountId: string,
  keys: (string | undefined)[],
  name: string,
): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const now = new Date().toISOString();
  for (const key of keys) {
    if (!key) continue;
    try {
      await db
        .insert(groupParticipantNames)
        .values({ accountId, waKey: key, name: clean, updatedAt: now })
        .onConflictDoUpdate({
          target: [groupParticipantNames.accountId, groupParticipantNames.waKey],
          set: { name: clean, updatedAt: now },
        });
    } catch (err) {
      console.error('[inbound] participant name upsert failed:', err);
    }
  }
}

/** Resolve a set of mention user-parts to display names (from the registry). */
async function lookupParticipantNames(
  accountId: string,
  users: string[],
): Promise<Record<string, string>> {
  const uniq = Array.from(new Set(users.filter(Boolean)));
  if (uniq.length === 0) return {};
  try {
    const rows = await db
      .select({
        waKey: groupParticipantNames.waKey,
        name: groupParticipantNames.name,
      })
      .from(groupParticipantNames)
      .where(
        and(
          eq(groupParticipantNames.accountId, accountId),
          inArray(groupParticipantNames.waKey, uniq),
        ),
      );
    const map: Record<string, string> = {};
    for (const r of rows) map[r.waKey] = r.name;
    return map;
  } catch (err) {
    console.error('[inbound] participant name lookup failed:', err);
    return {};
  }
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
    await rehostAvatar(contactId, pic.url);
  } catch (err) {
    console.error('[inbound] backfillContactAvatar failed:', err);
  }
}

/**
 * Same as {@link backfillContactAvatar} but for a monitored GROUP "contact":
 * fetches the group photo (keyed by group jid `@g.us`) and re-hosts it into the
 * SAME `contacts.avatar_url`, so a group thread shows its photo instead of just
 * an initial. WhatsApp can lag on a freshly-set group photo (miss → null); the
 * `isNull(avatar_url)` guard keeps this attempt-once-per-null, so a later group
 * message naturally retries until the photo has propagated.
 */
async function backfillGroupAvatar(
  channel: ChannelCtx,
  contactId: string,
  groupJid: string,
): Promise<void> {
  try {
    const provider = getProvider(channel.provider);
    if (typeof provider.fetchGroupPicture !== 'function') return;

    const pic = await provider.fetchGroupPicture(channel, groupJid);
    if (!pic || !pic.url) return;
    await rehostAvatar(contactId, pic.url);
  } catch (err) {
    console.error('[inbound] backfillGroupAvatar failed:', err);
  }
}

/**
 * Download a (short-lived, cross-origin) WhatsApp CDN photo URL, re-host the
 * bytes in MinIO under an `avatars/` key, and set `contacts.avatar_url` — but
 * only while it's still empty (race-safe, one-time backfill). Shared by the
 * 1:1 and group avatar backfills. The raw `pps.whatsapp.net` URL is never
 * stored: it expires and can be http/cross-origin.
 */
async function rehostAvatar(contactId: string, cdnUrl: string): Promise<void> {
  const res = await fetch(cdnUrl);
  if (!res.ok) {
    console.error(`[inbound] avatar fetch failed: ${res.status} ${cdnUrl}`);
    return;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) return;
  const mimetype =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';

  const ext = extensionFor(mimetype);
  const key = `avatars/${contactId}/${randomUUID()}${ext || '.jpg'}`;
  await putObject(MEDIA_BUCKET, key, bytes, mimetype);
  const url = publicUrl(MEDIA_BUCKET, key);

  await db
    .update(contacts)
    .set({ avatarUrl: url, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, contactId), isNull(contacts.avatarUrl)));
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
  opts?: { isGroup?: boolean },
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
          isGroup: opts?.isGroup ?? false,
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

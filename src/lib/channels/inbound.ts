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
import { and, count, eq, gte, inArray, isNull, sql } from 'drizzle-orm';

import {
  db,
  contacts,
  conversations,
  messages,
  monitoredGroups,
  groupParticipantNames,
  notifications,
} from '@/db';
import { firstOrNull } from '@/db/helpers';
import {
  findExistingContact,
  isUniqueViolation,
  type ExistingContact,
} from '@/lib/contacts/dedupe';
import { publishEvent } from '@/lib/events/publish';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import {
  enqueueAiReplyDebounced,
  enqueueDealSuggestDebounced,
} from '@/lib/queue/queues';
import { aiReplyBufferMs } from '@/lib/ai/defaults';
import { transcribeInboundAudio } from '@/lib/ai/transcribe';
import { describeImage } from '@/lib/ai/vision';
import { describeDocument } from '@/lib/ai/document';
import { loadAiConfig, loadAiConfigForChannel } from '@/lib/ai/config';
import { getAccountSettings } from '@/lib/settings/account-settings';
import { isWithinBusinessHours } from '@/lib/settings/business-hours';
import { engineSendText } from '@/lib/flows/meta-send';
import { maybeRecordCsat } from '@/lib/csat/csat';
import {
  routeNewConversation,
  rerouteByKeyword,
  channelDefaultSectorId,
} from '@/lib/sectors/routing';
import { putObject, publicUrl } from '@/lib/storage/s3';
import { CALL_PERM_PREFIX } from '@/lib/inbox/call-log';
import {
  groupJidDigits,
  prefixGroupAuthor,
  resolveGroupMentions,
} from '@/lib/whatsapp/group';
import { normalizeInboundPhoneBR } from '@/lib/whatsapp/phone-utils';
import { matchesOptOut, optOutContact } from '@/lib/contacts/opt-out';
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
  // Normalize the inbound number to E.164 up front. Some engines deliver a
  // Brazilian number in national-dialing form ("0 + carrier code + DDD +
  // número", e.g. "01527999438466"), whose leading 0 fails isValidE164 → the
  // contact is created unsendable and replying errors with "Invalid phone
  // number format" until the agent hand-edits it. normalizeInboundPhoneBR only
  // touches numbers that start with 0, so clean 55… numbers pass through as-is.
  const senderPhone = normalizeInboundPhoneBR(ev.fromPhoneE164);

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

  // 2) Resolve / create contact. Instagram (e canais sem telefone) chegam com
  //    `senderExternalId` (IGSID) e sem telefone → resolve por external_id;
  //    o resto (WhatsApp) resolve por E.164.
  const contactOutcome = ev.senderExternalId
    ? await findOrCreateContactByExternalId(
        accountId,
        ev.senderExternalId,
        isFromMe ? '' : ev.senderName ?? '',
      )
    : await findOrCreateContact(
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
  if (!isFromMe && !contactOutcome.contact.avatarUrl && !ev.senderExternalId) {
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
    }, conversation.channelId);
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

  // Entender IMAGEM (a IA "vê" a foto). Só para imagens do cliente e quando a
  // IA está ativa — a descrição usa o modelo de visão com a chave OpenAI do
  // cliente e é guardada como transcrição: a IA usa pra responder e o atendente
  // vê no card o que ela entendeu. Best-effort: null em qualquer falha.
  if (contentType === 'image' && mediaUrl && !isFromMe) {
    try {
      // Descreve a imagem só quando a IA ATENDE ESTE CANAL — resolvido pelo
      // MESMO seletor por canal do auto-reply (pickAgentIdForChannel), não pelo
      // agente default da conta. Com vários agentes ligados a canais diferentes,
      // o default podia não cobrir este canal → a visão era pulada em silêncio
      // (a IA respondia sem "ver" a foto e pedia a imagem de novo).
      const cfg = await loadAiConfigForChannel(accountId, channel.id, {
        requireAutoReply: true,
      });
      const visionKey = cfg
        ? cfg.provider === 'openai'
          ? cfg.apiKey
          : cfg.embeddingsApiKey
        : null;
      if (visionKey) {
        transcription = await describeImage(visionKey, mediaUrl);
      }
    } catch (err) {
      console.error('[inbound] image describe failed:', err);
    }
  }

  // Entender DOCUMENTO (PDF/DOCX/texto): extrai o texto + resume, igual à visão
  // da imagem. Mesmo gate por canal (só quando a IA atende o canal). O resumo
  // vira a transcrição — a IA responde e o atendente vê no card.
  if (contentType === 'document' && mediaUrl && !isFromMe) {
    try {
      const cfg = await loadAiConfigForChannel(accountId, channel.id, {
        requireAutoReply: true,
      });
      const docKey = cfg
        ? cfg.provider === 'openai'
          ? cfg.apiKey
          : cfg.embeddingsApiKey
        : null;
      if (docKey) {
        transcription = await describeDocument({
          apiKey: docKey,
          url: mediaUrl,
          mimetype: ev.media?.mimetype,
          filename: ev.media?.filename,
        });
      }
    } catch (err) {
      console.error('[inbound] document describe failed:', err);
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

  // Quoted reply (swipe-reply from WhatsApp): map the quoted external id to the
  // internal message so the CRM thread renders + links the citation, matching
  // WhatsApp. Best-effort — a quote of a message we never stored just renders
  // without the link. The stored external id is the normalized HASH, which is
  // exactly what the provider put in replyToExternalId.
  let replyToMessageId: string | null = null;
  if (ev.replyToExternalId) {
    try {
      const parent = firstOrNull(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.messageId, ev.replyToExternalId),
            ),
          )
          .limit(1),
      );
      replyToMessageId = parent?.id ?? null;
    } catch (err) {
      console.error('[inbound] reply-to lookup failed:', err);
    }
  }

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
      replyToMessageId,
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
    }, conversation.channelId);
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

  // Anti-ban: pedido de descadastro ("SAIR"/"PARAR" no WAHA, ou o botão "não
  // quero" do oficial). Marca o contato como "não perturbe", avisa a equipe, e
  // NÃO deixa a resposta cair em fluxo/automação/IA. Só bulk é suprimido —
  // atendimento 1:1 do humano segue normal.
  if (matchesOptOut(ev.contentText, ev.interactiveReplyId)) {
    try {
      const changed = await optOutContact(accountId, contactId, 'reply');
      if (changed) await notifyOptOut(accountId, contactId, conversation.id);
    } catch (err) {
      console.error('[inbound] opt-out handling failed:', err);
    }
    await dispatchWebhookEvent(accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contactId,
      whatsapp_message_id: ev.externalMessageId,
      content_type: contentType,
      text: ev.contentText ?? null,
    }, conversation.channelId);
    return { conversationId: conversation.id, contactId, isFirstInbound };
  }

  // Config da IA (carregado uma vez): decide se a IA é o respondente de
  // fora-do-horário e serve o buffer abaixo. requireActive default → null
  // quando a IA está desligada/inativa.
  const aiCfg = await loadAiConfig(accountId).catch(() => null);
  // A IA "cobre" o fora-do-horário quando está com auto-resposta ligada, no
  // modo que atende fora (outside/always) e cobre ESTE canal. Nesse caso a
  // mensagem padrão de fora-do-horário cede a vez pra ela — senão as duas
  // brigam e a padrão BLOQUEAVA a IA (bug do "só fora do horário").
  const aiHandlesOffHours =
    !!aiCfg &&
    aiCfg.autoReplyEnabled &&
    aiCfg.autoReplyHoursMode !== 'inside' &&
    (aiCfg.autoReplyChannelIds.length === 0 ||
      aiCfg.autoReplyChannelIds.includes(channel.id));

  // Out-of-hours auto-reply. When the customer writes outside business hours
  // (and we haven't already sent a closed-notice recently), send the account's
  // configured message and skip the AI auto-reply below — a human isn't
  // available, so the closed notice stands in for it. Pulado quando a IA vai
  // atender o fora-do-horário (ela É o respondente).
  const outOfHoursSent = aiHandlesOffHours
    ? false
    : await maybeSendOutOfHoursReply(
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
  // handled by the out-of-hours notice. BUFFER DE MENSAGENS: em vez de
  // responder na hora, agenda a resposta com um debounce por conversa — cada
  // nova mensagem RESETA o timer, então a IA só responde quando o cliente para
  // de mandar (junta a rajada numa resposta só). Os gates de elegibilidade são
  // re-checados no worker, na hora de disparar. Best-effort: nunca quebra o
  // inbound. `AI_REPLY_BUFFER_SECONDS=0` volta ao comportamento imediato.
  // A IA responde a TEXTO e também a MÍDIA que ela consegue "ler": imagem com
  // descrição de visão ou áudio transcrito (a transcrição já entra no contexto
  // como "[imagem]…"/"[áudio]…"). Sem isto, uma foto/nota de voz SEM legenda
  // era só descrita e ficava sem resposta (a IA "só transcrevia"). fromMe já
  // retornou lá em cima, então aqui é sempre mensagem do cliente.
  const mediaReadable =
    (contentType === 'image' ||
      contentType === 'audio' ||
      contentType === 'document') &&
    !!transcription?.trim();
  if (
    !flowConsumed &&
    !outOfHoursSent &&
    !ev.interactiveReplyId &&
    (inboundText.trim() || mediaReadable)
  ) {
    try {
      // Buffer por conta (config da IA já carregado acima); cai no env global
      // se a IA não estiver configurada/ativa nessa conta.
      let bufferMs = aiReplyBufferMs();
      if (aiCfg && typeof aiCfg.autoReplyBufferSeconds === 'number') {
        bufferMs = Math.max(0, Math.floor(aiCfg.autoReplyBufferSeconds * 1000));
      }
      await enqueueAiReplyDebounced(
        {
          accountId,
          conversationId: conversation.id,
          contactId,
          configOwnerUserId: contactOutcome.contact.userId,
        },
        bufferMs,
      );
    } catch (err) {
      console.error('[inbound] failed to enqueue AI reply:', err);
    }
  }

  // IA proativa em Negociações (v2 — Fase 3): se ligado na conta, agenda
  // (debounced por conversa) uma análise do negócio vinculado a esta conversa.
  // Os gates pesados (tem negócio ABERTO? cooldown?) são re-checados no worker.
  // Best-effort: nunca quebra o inbound. Toggle em ai_configs (default OFF).
  if (aiCfg?.dealSuggestionsProactive && inboundText.trim()) {
    try {
      const dealBufferMs = Math.max(
        0,
        Math.floor((Number(process.env.DEAL_SUGGEST_BUFFER_SECONDS) || 25) * 1000),
      );
      await enqueueDealSuggestDebounced(
        { accountId, conversationId: conversation.id },
        dealBufferMs,
      );
    } catch (err) {
      console.error('[inbound] failed to enqueue deal-suggest:', err);
    }
  }

  // message.received webhook (public API).
  await dispatchWebhookEvent(accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactId,
    whatsapp_message_id: ev.externalMessageId,
    content_type: contentType,
    text: ev.contentText ?? null,
  }, conversation.channelId);

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
  //     Pass the CANONICAL stored jid (`monitoredRow.groupJid`, from the GET
  //     /groups picker) rather than `group.jid`: the webhook jid can arrive
  //     bare/digits-only, but the profile-picture endpoint needs the full jid
  //     (old-format groups are `<creator>-<timestamp>@g.us` — the hyphen
  //     matters). Fire-and-forget: NEVER awaited on the critical path.
  if (!contactOutcome.contact.avatarUrl) {
    void backfillGroupAvatar(channel, contactId, monitoredRow.groupJid).catch(
      (err) =>
        console.error('[inbound] group avatar backfill dispatch failed:', err),
    );
  }

  // 4) Resolve/create the single group conversation for this channel.
  // isGroup → nasce SEM setor (livre pra toda a equipe).
  const convResult = await findOrCreateConversation(
    accountId,
    contactOutcome.contact.userId,
    contactId,
    channel.id,
    { isGroup: true },
  );
  if (!convResult) return null;
  const conversation = convResult.conversation;
  if (convResult.created) {
    await dispatchWebhookEvent(accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactId,
    }, conversation.channelId);
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

  // The stable key of THIS message's author (phone digits preferred — more
  // stable and shared with 1:1 contacts — else the LID user-part). Persisted on
  // the message so the inbox can render the sender's avatar per bubble. Null for
  // our own (fromMe) echoes: those are the agent side, no author avatar.
  const authorKey = isFromMe
    ? null
    : group.authorPhone?.trim() || group.authorLid?.trim() || null;

  // Register the author's pushName against their LID + phone so later @mentions
  // of them resolve to the name. Best-effort — never blocks the message.
  if (group.authorName) {
    await registerParticipantName(
      accountId,
      [group.authorLid, group.authorPhone],
      group.authorName,
    );
  }

  // Best-effort participant photo backfill — the per-author avatar in the group
  // thread. Only when we know the sender's PHONE (the profile-picture lookup
  // needs a @c.us id; a LID-only participant can't be fetched). Runs on any
  // incoming message; the helper's attempt-once guard keeps it cheap. NEVER
  // awaited on the critical path.
  if (!isFromMe && group.authorPhone) {
    void backfillParticipantAvatar(
      channel,
      accountId,
      [group.authorLid, group.authorPhone],
      group.authorPhone,
    ).catch((err) =>
      console.error('[inbound] participant avatar dispatch failed:', err),
    );
  }
  // Rewrite "@<number>" mentions in the body to the known display name, the way
  // WhatsApp shows them. Unknown participants stay as the number.
  if (group.mentions?.length) {
    const nameByUser = await lookupParticipantNames(accountId, group.mentions);
    // Second chance for mentions the registry couldn't name (the person was
    // mentioned but never posted, so we never learned their pushName): resolve
    // LID→phone via the group's participant list and match a saved contact.
    // Only fires when something is still unknown → no cost on the common path.
    const unknown = group.mentions.filter((u) => !nameByUser[u]);
    if (unknown.length) {
      await resolveUnknownMentionsViaContacts(
        channel,
        accountId,
        group.jid,
        unknown,
        nameByUser,
      );
    }
    baseText = resolveGroupMentions(baseText, group.mentions, nameByUser);
  }

  // Prefix the author so the single group thread stays legible. A fromMe echo
  // is OUR own post in the group → agent bubble, no prefix.
  const contentText = isFromMe
    ? baseText
    : prefixGroupAuthor(group.authorName ?? '', baseText);

  // Quoted reply from WhatsApp (swipe-reply in the group): map the quoted
  // external id to the internal message so the CRM thread renders the citation,
  // matching WhatsApp. Same as the 1:1 path — all group messages live in this
  // one conversation, and the stored external id is the normalized HASH, which
  // is exactly what the provider put in replyToExternalId. Best-effort: a quote
  // of a message we never stored just renders without the link.
  let replyToMessageId: string | null = null;
  if (ev.replyToExternalId) {
    try {
      const parent = firstOrNull(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, conversation.id),
              eq(messages.messageId, ev.replyToExternalId),
            ),
          )
          .limit(1),
      );
      replyToMessageId = parent?.id ?? null;
    } catch (err) {
      console.error('[inbound] group reply-to lookup failed:', err);
    }
  }

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
      replyToMessageId,
      status: isFromMe ? 'sent' : 'delivered',
      authorKey,
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
 * Per-(channel, group) cache of the LID user-part → phone-digits map derived
 * from the provider's participant list. The list is stable minute-to-minute but
 * a `GET /groups` round-trip is heavy, so we memoize it (promise included, so
 * concurrent group messages share one in-flight fetch) with a short TTL. The
 * async body never rejects — a failed/absent fetch caches an empty map, which
 * simply means "no LID fallback available", never a thrown error on the
 * ingestion hot-path.
 */
const GROUP_PARTICIPANT_TTL_MS = 10 * 60_000;
const groupParticipantCache = new Map<
  string,
  { expires: number; map: Promise<Map<string, string>> }
>();

function groupLidToPhone(
  channel: ChannelCtx,
  groupJid: string,
): Promise<Map<string, string>> {
  const cacheKey = `${channel.id}::${groupJidDigits(groupJid)}`;
  const now = Date.now();
  const hit = groupParticipantCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.map;

  const map = (async () => {
    const provider = getProvider(channel.provider);
    if (typeof provider.listGroupParticipants !== 'function') {
      return new Map<string, string>();
    }
    try {
      const parts = await provider.listGroupParticipants(channel, groupJid);
      const out = new Map<string, string>();
      for (const p of parts) {
        if (p.lidUser && p.phone) out.set(p.lidUser, p.phone);
      }
      return out;
    } catch (err) {
      console.error('[inbound] group participant fetch failed:', err);
      return new Map<string, string>();
    }
  })();

  groupParticipantCache.set(cacheKey, {
    expires: now + GROUP_PARTICIPANT_TTL_MS,
    map,
  });
  return map;
}

/**
 * Fallback for @mentions the registry couldn't name (the person was mentioned
 * but never posted, so we never learned their pushName). Resolve each unknown
 * LID → phone, then match that phone against the CRM's saved `contacts` by
 * phone_normalized:
 *   - a saved contact → adopt its name AND prime the registry (under both the
 *     LID user-part and the phone) so the next mention is a cheap lookup;
 *   - no saved contact but a resolved phone → render the PHONE instead of the
 *     meaningless LID, exactly like WhatsApp shows an unknown participant.
 * LID→phone comes from the engine's own LID↔PN map first (authoritative, keyed
 * to THIS channel's session, cached per lid), falling back to the group's
 * participant list — fetched lazily, since it costs a full /groups round-trip.
 * Nothing resolves → the token stays. Mutates `nameByUser` in place.
 * Best-effort: any failure leaves it untouched.
 */
async function resolveUnknownMentionsViaContacts(
  channel: ChannelCtx,
  accountId: string,
  groupJid: string,
  unknownUsers: string[],
  nameByUser: Record<string, string>,
): Promise<void> {
  try {
    const provider = getProvider(channel.provider);
    const phoneByUser = new Map<string, string>();
    const phones = new Set<string>();
    // Pass 1 — the engine's LID↔PN map (cheap, per-lid, cached in the provider).
    const stillUnknown: string[] = [];
    for (const u of unknownUsers) {
      let phone = '';
      if (typeof provider.resolveLidToPhone === 'function') {
        try {
          phone = (await provider.resolveLidToPhone(channel, u)) || '';
        } catch {
          // best-effort — fall through to the participant list
        }
      }
      if (phone) {
        phoneByUser.set(u, phone);
        phones.add(phone);
      } else {
        stillUnknown.push(u);
      }
    }
    // Pass 2 — only if something is left, pay for the group participant list.
    if (stillUnknown.length) {
      const lidToPhone = await groupLidToPhone(channel, groupJid);
      for (const u of stillUnknown) {
        // The mention token itself is already a phone in a non-@lid group.
        const phone = lidToPhone.get(u) || u;
        if (!phone) continue;
        phoneByUser.set(u, phone);
        phones.add(phone);
      }
    }
    if (phones.size === 0) return;

    const rows = await db
      .select({
        name: contacts.name,
        phoneNormalized: contacts.phoneNormalized,
      })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          eq(contacts.isGroup, false),
          inArray(contacts.phoneNormalized, Array.from(phones)),
        ),
      );
    const nameByPhone = new Map<string, string>();
    for (const r of rows) {
      const name = (r.name ?? '').trim();
      if (name && r.phoneNormalized) nameByPhone.set(r.phoneNormalized, name);
    }

    for (const u of unknownUsers) {
      const phone = phoneByUser.get(u);
      if (!phone) continue;
      const name = nameByPhone.get(phone);
      if (name) {
        nameByUser[u] = name;
        // Prime the registry so future mentions skip the resolution entirely.
        await registerParticipantName(accountId, [u, phone], name);
      } else if (phone !== u) {
        // Not a saved contact, but we DID resolve the phone — show it instead
        // of the raw LID (a meaningless 15-digit id), matching how WhatsApp
        // renders a mention of someone you don't have saved. Deliberately NOT
        // written to the name registry: that table holds real display names,
        // and the person may still post later with a proper pushName.
        nameByUser[u] = phone;
      }
    }
  } catch (err) {
    console.error('[inbound] mention contact-fallback failed:', err);
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
 * Best-effort backfill of a GROUP participant's profile photo into
 * `group_participant_names.avatar_url`, so the inbox can show that person's
 * avatar next to their group bubbles. Fetches by the participant's PHONE (the
 * same @c.us profile-picture path as 1:1 contacts) and writes the re-hosted URL
 * onto EVERY wa_key the participant is known by (`keys` = [LID, phone]), so a
 * message keyed by either addressing form resolves. Attempt-once-per-null:
 * skipped once any of those rows already has a photo. Fire-and-forget — a
 * hiccup must never affect the group message that spawned it.
 */
async function backfillParticipantAvatar(
  channel: ChannelCtx,
  accountId: string,
  keys: (string | undefined)[],
  phoneE164: string,
): Promise<void> {
  try {
    const waKeys = keys.filter((k): k is string => !!k && k.trim() !== '');
    if (waKeys.length === 0) return;

    const provider = getProvider(channel.provider);
    if (typeof provider.fetchProfilePicture !== 'function') return;

    // Attempt-once: bail if any of this participant's rows already has a photo.
    const existing = await db
      .select({ avatarUrl: groupParticipantNames.avatarUrl })
      .from(groupParticipantNames)
      .where(
        and(
          eq(groupParticipantNames.accountId, accountId),
          inArray(groupParticipantNames.waKey, waKeys),
        ),
      );
    if (existing.some((r) => r.avatarUrl)) return;

    const pic = await provider.fetchProfilePicture(channel, phoneE164);
    if (!pic || !pic.url) return;

    const url = await rehostImage(pic.url, `participants/${accountId}`);
    if (!url) return;

    // Only set rows still missing a photo (race-safe, keeps it one-time).
    await db
      .update(groupParticipantNames)
      .set({ avatarUrl: url, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(groupParticipantNames.accountId, accountId),
          inArray(groupParticipantNames.waKey, waKeys),
          isNull(groupParticipantNames.avatarUrl),
        ),
      );
  } catch (err) {
    console.error('[inbound] backfillParticipantAvatar failed:', err);
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
  const url = await rehostImage(cdnUrl, contactId);
  if (!url) return;
  await db
    .update(contacts)
    .set({ avatarUrl: url, updatedAt: new Date().toISOString() })
    .where(and(eq(contacts.id, contactId), isNull(contacts.avatarUrl)));
}

/**
 * Download a WhatsApp CDN image and re-host the bytes in MinIO under
 * `avatars/<keyHint>/<uuid>.<ext>`, returning the stable public proxy URL (or
 * null on any hiccup). The re-host is shared by every avatar backfill; only the
 * DB write differs per caller.
 */
async function rehostImage(
  cdnUrl: string,
  keyHint: string,
): Promise<string | null> {
  const res = await fetch(cdnUrl);
  if (!res.ok) {
    console.error(`[inbound] avatar fetch failed: ${res.status} ${cdnUrl}`);
    return null;
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) return null;
  const mimetype =
    res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';

  const ext = extensionFor(mimetype);
  const key = `avatars/${keyHint}/${randomUUID()}${ext || '.jpg'}`;
  await putObject(MEDIA_BUCKET, key, bytes, mimetype);
  return publicUrl(MEDIA_BUCKET, key);
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
  // Shape an existing row into the outcome. We only *fill* the name from the
  // WhatsApp pushName while the contact still has no real name yet (empty, or
  // still the bare phone from creation). Once a real name exists — whether the
  // first pushName or a name the operator typed in the CRM — WhatsApp must NOT
  // overwrite it, otherwise every new message reverts a CRM-edited name back to
  // the WhatsApp one. (WhatsApp name changes after that point are ignored on
  // purpose: the CRM is the source of truth for a saved contact's name.)
  const asExisting = async (
    existing: ExistingContact,
  ): Promise<ContactOutcome> => {
    const isBarePhone = (s: string) => /^\+?\d[\d\s()\-]{4,}$/.test(s.trim());
    const hasRealName =
      !!existing.name &&
      existing.name !== phone &&
      !isBarePhone(existing.name);
    if (name && name !== existing.name && !hasRealName) {
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
        name: existing.name ?? null,
        avatarUrl: (existing.avatarUrl ?? null) as string | null,
      },
      wasCreated: false,
    };
  };

  // FAST PATH (the common case): the contact already exists → no lock/tx.
  const pre = await findExistingContact(accountId, phone);
  if (pre) return asExisting(pre);

  // SLOW PATH — creating. Serialize per-person so the Brazilian 9th-digit race
  // can't spawn a duplicate: two near-simultaneous inbounds (one WITH the extra
  // 9, one WITHOUT) both miss the fuzzy dedup and insert twice, because the
  // unique index is on the EXACT phone_normalized. A Postgres advisory lock
  // keyed on (account, last-8 digits) makes the 2nd creator wait for the 1st's
  // transaction, so its re-check finds the freshly-created row. xact-scoped so
  // it always releases at commit/rollback (safe with the connection pool).
  const digits = phone.replace(/\D/g, '');
  const last8 = digits.length >= 8 ? digits.slice(-8) : digits;
  const lockKey = `contact:${accountId}:${last8}`;

  const ownerUserId = await resolveAccountOwnerUserId(accountId);
  if (!ownerUserId) {
    console.error(
      '[inbound] no member found for account; cannot create contact',
      accountId,
    );
    return null;
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
      );
      // Re-check under the lock — a concurrent creator may have won the race.
      const raced = await findExistingContact(accountId, phone);
      if (raced) return asExisting(raced);

      const created = firstOrNull(
        await tx
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
    });
  } catch (createError) {
    // Backstop for an EXACT-normalized collision that still raced past the lock.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(accountId, phone);
      if (raced) return asExisting(raced);
    }
    console.error('[inbound] Error creating contact:', createError);
    return null;
  }
}

/**
 * Resolve/cria contato por ID EXTERNO (ex.: IGSID do Instagram Direct) — canais
 * sem telefone. `phone` fica '' (phone_normalized '' fica fora do índice único de
 * telefone); a unicidade é por (conta, external_id). Advisory lock por
 * (conta, external_id) evita duplicar em inbounds concorrentes.
 */
/**
 * Inicia (ou reabre) uma conversa de E-MAIL a partir de um endereço digitado
 * pelo agente — o equivalente do "nova conversa" pros canais por endereço.
 * Resolve o contato por external_id (o e-mail, minúsculo) + a conversa
 * (conta, contato, canal). O envio em si sai depois pelo composer normal.
 */
export async function resolveEmailConversation(
  channel: ChannelCtx,
  email: string,
  name: string | null,
): Promise<{ conversationId: string; contactCreated: boolean }> {
  const addr = email.trim().toLowerCase();
  const contactOutcome = await findOrCreateContactByExternalId(
    channel.accountId,
    addr,
    name?.trim() || '',
  );
  if (!contactOutcome) throw new Error('Não foi possível criar o contato.');
  const convResult = await findOrCreateConversation(
    channel.accountId,
    contactOutcome.contact.userId,
    contactOutcome.contact.id,
    channel.id,
  );
  if (!convResult) throw new Error('Não foi possível criar a conversa.');
  return {
    conversationId: convResult.conversation.id,
    contactCreated: contactOutcome.wasCreated,
  };
}

async function findOrCreateContactByExternalId(
  accountId: string,
  externalId: string,
  name: string,
): Promise<ContactOutcome | null> {
  const findByExt = async () =>
    firstOrNull(
      await db
        .select({
          id: contacts.id,
          userId: contacts.userId,
          name: contacts.name,
          avatarUrl: contacts.avatarUrl,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.accountId, accountId),
            eq(contacts.externalId, externalId),
          ),
        )
        .limit(1),
    );

  const asOutcome = async (existing: {
    id: string;
    userId: string;
    name: string | null;
    avatarUrl: string | null;
  }): Promise<ContactOutcome> => {
    // Preenche o nome só enquanto o contato ainda não tem um nome real.
    if (name && name !== existing.name && (!existing.name || existing.name === externalId)) {
      try {
        await db
          .update(contacts)
          .set({ name, updatedAt: new Date().toISOString() })
          .where(eq(contacts.id, existing.id));
      } catch {
        /* best-effort */
      }
    }
    return {
      contact: {
        id: existing.id,
        userId: String(existing.userId),
        name: existing.name ?? null,
        avatarUrl: existing.avatarUrl ?? null,
      },
      wasCreated: false,
    };
  };

  const pre = await findByExt();
  if (pre) return asOutcome(pre);

  const ownerUserId = await resolveAccountOwnerUserId(accountId);
  if (!ownerUserId) {
    console.error('[inbound] no member found for account; cannot create IG contact', accountId);
    return null;
  }
  const lockKey = `igcontact:${accountId}:${externalId}`;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const raced = await findByExt();
      if (raced) return asOutcome(raced);
      const created = firstOrNull(
        await tx
          .insert(contacts)
          .values({
            accountId,
            userId: ownerUserId,
            phone: '',
            externalId,
            name: name || externalId,
          })
          .returning(),
      );
      if (!created) return null;
      return {
        contact: {
          id: created.id,
          userId: created.userId,
          name: created.name,
          avatarUrl: created.avatarUrl ?? null,
        },
        wasCreated: true,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await findByExt();
      if (raced) return asOutcome(raced);
    }
    console.error('[inbound] criar contato IG falhou:', err);
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
  opts?: { isGroup?: boolean },
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

  // Stamp the channel's default sector at birth so a conversation is NEVER
  // created in the open general queue when its channel belongs to a sector.
  // The keyword/inbound routing below only runs for customer (non-fromMe)
  // messages, so an agent-STARTED thread (first message outbound) used to stay
  // sector-less and leak to every sector. Null when the channel has no sector.
  // EXCEÇÃO: GRUPOS nascem SEM setor (Felipe) — grupo é livre pra toda a equipe
  // (setor null + sem dono = fila geral, visível e respondível por todos).
  const bornSectorId = opts?.isGroup
    ? null
    : await channelDefaultSectorId(channelId);

  try {
    const created = firstOrNull(
      await db
        .insert(conversations)
        .values({
          accountId,
          userId,
          contactId,
          channelId,
          sectorId: bornSectorId,
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

/** Avisa a equipe (dono do contato) que alguém pediu pra sair da lista. */
async function notifyOptOut(
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<void> {
  const c = firstOrNull(
    await db
      .select({
        name: contacts.name,
        phone: contacts.phone,
        userId: contacts.userId,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1),
  );
  if (!c) return;
  const who = c.name || c.phone || 'Um contato';
  await db.insert(notifications).values({
    accountId,
    userId: c.userId,
    type: 'contact_opted_out',
    conversationId,
    contactId,
    title: `${who} pediu pra não receber mais`,
    body: 'Marquei como "Não perturbe" — disparos e agendamentos já pulam esse contato. Se quiser, tire-o da lista.',
  });
  await publishEvent(accountId, { type: 'notification' });
}

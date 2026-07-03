// ============================================================
// Meta (official WhatsApp Cloud API) provider adapter (Phase 4, wave 2).
//
// Implements `WhatsAppProvider` for provider 'meta' by delegating every
// network call to the existing helpers in src/lib/whatsapp/meta-api.ts —
// this file is a thin conformance layer, NOT a reimplementation. The only
// real logic here is:
//   * shaping ChannelCtx.{credentials,providerMeta} into meta-api arg
//     objects,
//   * porting the webhook parse from src/app/api/whatsapp/webhook/route.ts
//     into `parseWebhook` (→ NormalizedInbound[] / NormalizedStatus[]),
//   * HMAC verification via verifyMetaWebhookSignature (global
//     META_APP_SECRET, NOT a per-channel secret for Meta).
//
// Media: Meta sends outbound media by public URL (`link`) and delivers
// inbound media as an id that must be resolved (getMediaUrl → downloadMedia).
// The unified inbound pipeline (inbound.ts) stores bytes to MinIO, so
// `fetchInboundMedia` returns { base64, mimetype } for it to persist.
//
// Sessions: Meta has no QR pairing (capabilities.qrPairing = false), so
// startSession / getState are intentionally omitted.
//
// See docs/fase4-multicanal.md → "META (oficial)".
// ============================================================

import { CAPABILITIES } from '../provider';
import type {
  ChannelCtx,
  NormalizedInbound,
  NormalizedStatus,
  OutboundInteractive,
  OutboundMedia,
  OutboundTemplate,
  ParsedWebhook,
  SendOptions,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider';

import {
  downloadMedia,
  getMediaUrl,
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  type InteractiveButton,
  type InteractiveListSection,
  type MediaKind,
} from '@/lib/whatsapp/meta-api';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';

// ------------------------------------------------------------
// ChannelCtx → meta-api arg extraction
// ------------------------------------------------------------
//
// credentials JSON for meta is `{ accessToken, verifyToken }`;
// provider_meta is `{ phone_number_id, waba_id }` (see the cheat-sheet
// schema). Pull the two things every send needs — access token + phone
// number id — with a clear error if the channel row is misconfigured.

function accessTokenOf(ch: ChannelCtx): string {
  const token = ch.credentials.accessToken;
  if (typeof token !== 'string' || !token) {
    throw new Error(`meta channel ${ch.id} is missing credentials.accessToken`);
  }
  return token;
}

function phoneNumberIdOf(ch: ChannelCtx): string {
  const pnid = ch.providerMeta.phone_number_id;
  if (typeof pnid !== 'string' || !pnid) {
    throw new Error(
      `meta channel ${ch.id} is missing providerMeta.phone_number_id`,
    );
  }
  return pnid;
}

// ------------------------------------------------------------
// Webhook payload types (ported from webhook/route.ts)
// ------------------------------------------------------------

interface MetaWebhookMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: {
    id: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji: string };
  interactive?: {
    type: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  context?: { id: string };
}

interface MetaWebhookContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface MetaWebhookStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
}

interface MetaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaWebhookContact[];
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
}

interface MetaWebhookChange {
  field?: string;
  value?: MetaWebhookValue;
}

interface MetaWebhookEntry {
  id?: string;
  changes?: MetaWebhookChange[];
}

interface MetaWebhookBody {
  entry?: MetaWebhookEntry[];
}

/** NormalizedInbound.contentType values Meta can produce. */
type InboundContentType = NormalizedInbound['contentType'];

// ------------------------------------------------------------
// Provider implementation
// ------------------------------------------------------------

export const metaProvider: WhatsAppProvider = {
  id: 'meta',
  capabilities: CAPABILITIES.meta,

  async sendText(
    ch: ChannelCtx,
    toE164: string,
    text: string,
    opts?: SendOptions,
  ): Promise<{ externalMessageId: string }> {
    const result = await sendTextMessage({
      phoneNumberId: phoneNumberIdOf(ch),
      accessToken: accessTokenOf(ch),
      to: toE164,
      text,
      contextMessageId: opts?.contextExternalId,
    });
    return { externalMessageId: result.messageId };
  },

  async sendMedia(
    ch: ChannelCtx,
    toE164: string,
    media: OutboundMedia,
  ): Promise<{ externalMessageId: string }> {
    // Meta fetches media by public URL at send time — media.url must be the
    // MinIO public URL. base64 is not supported by the Cloud API link path.
    if (!media.url) {
      throw new Error(
        'meta sendMedia requires media.url (public link); base64 is not supported by the Cloud API.',
      );
    }
    const result = await sendMediaMessage({
      phoneNumberId: phoneNumberIdOf(ch),
      accessToken: accessTokenOf(ch),
      to: toE164,
      kind: media.kind as MediaKind,
      link: media.url,
      caption: media.caption,
      filename: media.filename,
    });
    return { externalMessageId: result.messageId };
  },

  async sendTemplate(
    ch: ChannelCtx,
    toE164: string,
    tpl: OutboundTemplate,
  ): Promise<{ externalMessageId: string }> {
    // Map the OutboundTemplate onto sendTemplateMessage's shape, mirroring
    // how send-message.ts calls it: `template` (the row) drives header +
    // buttons; `messageParams` carries per-send values; `params` is the
    // legacy body-only string[] fallback. `tpl.params` is intentionally
    // loose (unknown) in the interface — narrow it here.
    const p = normalizeTemplateParams(tpl.params);
    const result = await sendTemplateMessage({
      phoneNumberId: phoneNumberIdOf(ch),
      accessToken: accessTokenOf(ch),
      to: toE164,
      templateName: tpl.name,
      language: tpl.language,
      template: p.template,
      messageParams: p.messageParams,
      params: p.body,
    });
    return { externalMessageId: result.messageId };
  },

  async sendInteractive(
    ch: ChannelCtx,
    toE164: string,
    i: OutboundInteractive,
  ): Promise<{ externalMessageId: string }> {
    const phoneNumberId = phoneNumberIdOf(ch);
    const accessToken = accessTokenOf(ch);

    // Dispatch by shape: a `buttons` array → reply-button message;
    // `sections` (or a `list` button label) → list message. Body/header/
    // footer are shared. Values are validated inside the meta-api helpers.
    const bodyText = asString(i.bodyText) ?? asString(i.body) ?? '';
    const headerText = asString(i.headerText);
    const footerText = asString(i.footerText);
    const contextMessageId = asString(i.contextMessageId);

    const buttons = i.buttons;
    const sections = i.sections;

    if (Array.isArray(buttons)) {
      const result = await sendInteractiveButtons({
        phoneNumberId,
        accessToken,
        to: toE164,
        bodyText,
        headerText,
        footerText,
        buttons: buttons as InteractiveButton[],
        contextMessageId,
      });
      return { externalMessageId: result.messageId };
    }

    if (Array.isArray(sections)) {
      const buttonLabel =
        asString(i.buttonLabel) ?? asString(i.button) ?? 'Menu';
      const result = await sendInteractiveList({
        phoneNumberId,
        accessToken,
        to: toE164,
        bodyText,
        buttonLabel,
        headerText,
        footerText,
        sections: sections as InteractiveListSection[],
        contextMessageId,
      });
      return { externalMessageId: result.messageId };
    }

    throw new Error(
      'meta sendInteractive: payload must carry a `buttons` array (reply buttons) or a `sections` array (list).',
    );
  },

  async sendReaction(
    ch: ChannelCtx,
    targetExternalId: string,
    emoji: string,
  ): Promise<void> {
    // Meta's reaction send needs the recipient `to`. The unified interface
    // only gives us the target message id + emoji, so the recipient comes
    // from providerMeta.reaction_to when the caller wired it, else we can't
    // route it. In practice the outbound funnel (wave 3) passes the
    // conversation's phone; here we accept it via providerMeta for now and
    // fall back to targetExternalId's owner being unknown.
    const to = reactionRecipientOf(ch);
    await sendReactionMessage({
      phoneNumberId: phoneNumberIdOf(ch),
      accessToken: accessTokenOf(ch),
      to,
      targetMessageId: targetExternalId,
      emoji,
    });
  },

  async verifyWebhook(
    ctx: WebhookVerifyCtx,
    _ch: ChannelCtx | null,
  ): Promise<boolean> {
    // Meta signs the raw body with the GLOBAL app secret (META_APP_SECRET),
    // not a per-channel secret — so `_ch` is unused here. The signature is
    // in the `x-hub-signature-256` header as `sha256=<hex>`.
    const signature = ctx.headers.get('x-hub-signature-256');
    return verifyMetaWebhookSignature(ctx.rawBody, signature);
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const messages: NormalizedInbound[] = [];
    const statuses: NormalizedStatus[] = [];

    const parsed = body as MetaWebhookBody | null;
    if (!parsed || !Array.isArray(parsed.entry)) {
      return { messages, statuses };
    }

    for (const entry of parsed.entry) {
      if (!Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        const value = change.value;
        if (!value) continue;

        // Template-lifecycle events (status/quality/components) arrive on a
        // different change.field with a non-message value shape. The
        // existing template-webhook handler stays separate — return empty
        // for those branches so we never misread a template event as a
        // message. They simply lack `messages`/`statuses`, so the loops
        // below no-op; nothing extra needed.

        // ---- inbound messages ----
        if (Array.isArray(value.messages)) {
          const contacts = value.contacts ?? [];
          for (let idx = 0; idx < value.messages.length; idx++) {
            const msg = value.messages[idx];
            const contact = contacts[idx] ?? contacts[0];
            const normalized = normalizeInboundMessage(msg, contact);
            if (normalized) messages.push(normalized);
          }
        }

        // ---- delivery/read receipts ----
        if (Array.isArray(value.statuses)) {
          for (const st of value.statuses) {
            // The ≥2 rule: read=3, delivered=2. sent/failed and anything
            // else are not surfaced as NormalizedStatus.
            const level =
              st.status === 'read' ? 3 : st.status === 'delivered' ? 2 : null;
            if (level !== null && st.id) {
              statuses.push({ externalMessageId: st.id, level });
            }
          }
        }
      }
    }

    return { messages, statuses };
  },

  async fetchInboundMedia(
    ch: ChannelCtx,
    fetchKey: unknown,
  ): Promise<{ base64: string; mimetype: string } | null> {
    // For Meta, fetchKey is the media id delivered in the webhook. Resolve
    // it to a short-lived CDN URL, download the bytes, and hand them back
    // as base64 so inbound.ts can persist them to MinIO like every other
    // provider. Returns null on failure so a media hiccup never drops the
    // whole inbound message.
    const mediaId = typeof fetchKey === 'string' ? fetchKey : String(fetchKey);
    if (!mediaId) return null;
    const accessToken = accessTokenOf(ch);
    try {
      const { url, mimeType } = await getMediaUrl({ mediaId, accessToken });
      const { buffer, contentType } = await downloadMedia({
        downloadUrl: url,
        accessToken,
      });
      return {
        base64: buffer.toString('base64'),
        mimetype: contentType || mimeType || 'application/octet-stream',
      };
    } catch (err) {
      console.error(
        `[meta] fetchInboundMedia failed for media ${mediaId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },

  // No startSession / getState: Meta has no QR pairing (capabilities.qrPairing
  // is false). The interface marks both optional, so they're omitted.
};

// ------------------------------------------------------------
// Inbound normalization (ported from parseMessageContent)
// ------------------------------------------------------------

/**
 * Turn one Meta webhook message into a NormalizedInbound, or null when it
 * carries nothing we ingest as a message.
 *
 * Type mapping (mirrors webhook/route.ts):
 *   text        → contentType 'text',  contentText = text.body
 *   image       → 'image',  media {kind:'image',  fetchKey: id}, caption→contentText
 *   video       → 'video',  media {kind:'video',  fetchKey: id}, caption→contentText
 *   audio       → 'audio',  media {kind:'audio',  fetchKey: id}
 *   document    → 'document', media {kind:'document', fetchKey: id, filename}, caption/filename→contentText
 *   sticker     → 'image',  media {kind:'sticker', fetchKey: id}   (rendered as image)
 *   location    → 'location', contentText = "name - address - lat,lng"
 *   interactive → 'interactive', interactiveReplyId = reply.id, contentText = reply.title
 *   reaction    → null (reactions aren't messages; handled elsewhere)
 *   unknown     → 'text', contentText = "[Unsupported message type: X]"
 */
function normalizeInboundMessage(
  msg: MetaWebhookMessage,
  contact: MetaWebhookContact | undefined,
): NormalizedInbound | null {
  // Reactions are per-(target, actor) state, not messages — the legacy
  // webhook short-circuits them. The unified pipeline has no reaction path,
  // so we drop them here rather than inserting a spurious message row.
  if (msg.type === 'reaction') return null;

  const base = {
    externalMessageId: msg.id,
    fromPhoneE164: normalizePhone(msg.from),
    fromMe: false,
    pushName: contact?.profile?.name || undefined,
    replyToExternalId: msg.context?.id,
  };

  const media = (
    kind: string,
    m: { id: string; mime_type?: string } | undefined,
    filename?: string,
  ): NonNullable<NormalizedInbound['media']> | undefined =>
    m?.id
      ? { kind, mimetype: m.mime_type, fetchKey: m.id, filename }
      : undefined;

  switch (msg.type) {
    case 'text':
      return {
        ...base,
        contentType: 'text',
        contentText: msg.text?.body ?? null,
      };

    case 'image':
      return {
        ...base,
        contentType: 'image',
        contentText: msg.image?.caption ?? null,
        media: media('image', msg.image),
      };

    case 'video':
      return {
        ...base,
        contentType: 'video',
        contentText: msg.video?.caption ?? null,
        media: media('video', msg.video),
      };

    case 'audio':
      return {
        ...base,
        contentType: 'audio',
        contentText: null,
        media: media('audio', msg.audio),
      };

    case 'document':
      return {
        ...base,
        contentType: 'document',
        contentText: msg.document?.caption ?? msg.document?.filename ?? null,
        media: media('document', msg.document, msg.document?.filename),
      };

    case 'sticker':
      // Stickers are images under the hood — same content type so the inbox
      // renders an <img>; the pipeline maps it to messages.content_type.
      return {
        ...base,
        contentType: 'image',
        contentText: null,
        media: media('sticker', msg.sticker),
      };

    case 'location': {
      const loc = msg.location;
      if (!loc) return { ...base, contentType: 'location', contentText: null };
      const text = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(' - ');
      return { ...base, contentType: 'location', contentText: text };
    }

    case 'interactive': {
      const reply =
        msg.interactive?.button_reply ?? msg.interactive?.list_reply;
      if (reply?.id) {
        return {
          ...base,
          contentType: 'interactive',
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        };
      }
      return {
        ...base,
        contentType: 'interactive',
        contentText: '[Interactive reply]',
      };
    }

    default:
      return {
        ...base,
        contentType: 'text' as InboundContentType,
        contentText: `[Unsupported message type: ${msg.type}]`,
      };
  }
}

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Resolve the recipient phone for a reaction send. The unified sendReaction
 * signature carries only the target message id + emoji, so the recipient is
 * threaded through providerMeta.reaction_to by the outbound funnel (wave 3).
 */
function reactionRecipientOf(ch: ChannelCtx): string {
  const to = ch.providerMeta.reaction_to;
  if (typeof to !== 'string' || !to) {
    throw new Error(
      `meta sendReaction needs the recipient phone in providerMeta.reaction_to for channel ${ch.id}.`,
    );
  }
  return to;
}

interface NormalizedTemplateParams {
  template?: MessageTemplate;
  messageParams?: SendTimeParams;
  body?: string[];
}

/**
 * Narrow OutboundTemplate.params (typed `unknown`) into the pieces
 * sendTemplateMessage wants. Accepts three shapes, matching send-message.ts:
 *   - string[]                          → legacy body-only params
 *   - { body?: string[]; ... }          → structured SendTimeParams
 *   - { template, messageParams, body } → full structured payload
 */
function normalizeTemplateParams(params: unknown): NormalizedTemplateParams {
  if (params == null) return {};
  if (Array.isArray(params)) {
    return { body: params.map((p) => String(p)) };
  }
  if (typeof params === 'object') {
    const obj = params as {
      template?: MessageTemplate;
      messageParams?: SendTimeParams;
      body?: unknown;
    } & SendTimeParams;
    // If a nested messageParams is present, prefer it; otherwise treat the
    // object itself as the SendTimeParams (body/headerText/...).
    const messageParams = obj.messageParams ?? stripTemplateKeys(obj);
    const body = Array.isArray(obj.body)
      ? obj.body.map((p) => String(p))
      : undefined;
    return { template: obj.template, messageParams, body };
  }
  return {};
}

/** Drop the wrapper keys so the remainder is a clean SendTimeParams. */
function stripTemplateKeys(
  obj: { template?: MessageTemplate; messageParams?: SendTimeParams } & SendTimeParams,
): SendTimeParams | undefined {
  const { headerText, headerMediaUrl, headerMediaId, buttonParams, body } = obj;
  const bodyArr = Array.isArray(body) ? body.map((p) => String(p)) : undefined;
  const sp: SendTimeParams = {};
  if (bodyArr) sp.body = bodyArr;
  if (headerText !== undefined) sp.headerText = headerText;
  if (headerMediaUrl !== undefined) sp.headerMediaUrl = headerMediaUrl;
  if (headerMediaId !== undefined) sp.headerMediaId = headerMediaId;
  if (buttonParams !== undefined) sp.buttonParams = buttonParams;
  return Object.keys(sp).length > 0 ? sp : undefined;
}

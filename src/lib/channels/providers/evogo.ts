// ============================================================
// EvoGo (evolution-go / whatsmeow) provider adapter (Phase 4, wave 2).
//
// Implements `WhatsAppProvider` for provider 'evogo'. EvoGo is a Go
// re-implementation of a WhatsApp bridge on top of whatsmeow. Auth is a
// per-instance token sent as the `apikey` header; the instance's base URL
// lives in providerMeta.baseUrl. This adapter mirrors the structure of
// meta.ts (thin conformance layer + a small httpJson helper) and ports the
// tested behaviour of RecebIA's EvoGoAdapter.js.
//
// CRITICAL LIMITATION — inbound media:
//   EvoGo does NOT deliver inbound media base64 in the webhook and exposes
//   NO fetch API to pull the bytes later (unlike Evolution's
//   getBase64FromMediaMessage). Inbound media is therefore structurally
//   impossible here → capabilities.inboundMedia = false. Rather than store a
//   media row with no bytes, parseWebhook downgrades an inbound media message
//   to a `text` NormalizedInbound with a readable Portuguese placeholder
//   (e.g. "[imagem recebida — EvoGo não entrega mídia]"). This keeps the
//   inbox clean and honest instead of a broken image tile. `fetchInboundMedia`
//   is intentionally omitted for the same reason. (Alex hit this in RecebIA.)
//
// @lid handling: whatsmeow surfaces WhatsApp's newer "linked id" (@lid) JIDs.
//   For INBOUND (the common case) the real phone is in info.Chat / info.Sender
//   and the @lid appears in info.SenderAlt — we pick the non-@lid JID and
//   normalize its digits. For fromMe echoes the real phone is NOT present in
//   the payload (Chat carries the @lid), so mirroring our own sends would need
//   a persistent lid→phone map (RecebIA's wa_lid_map). That map is out of
//   scope for v1 — see the `// TODO: lid→phone map for fromMe` below.
//
// See docs/fase4-multicanal.md → "EVOGO (evolution-go / whatsmeow)".
// ============================================================

import { CAPABILITIES } from '../provider';
import type {
  ChannelCtx,
  NormalizedInbound,
  NormalizedStatus,
  OutboundMedia,
  ParsedWebhook,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

// ------------------------------------------------------------
// ChannelCtx → routing/auth extraction
// ------------------------------------------------------------
//
// credentials JSON for evogo is `{ token }`; provider_meta is `{ baseUrl }`
// (see the cheat-sheet schema). Every call needs both, with a clear error
// when the channel row is misconfigured.

function baseUrlOf(ch: ChannelCtx): string {
  const base = ch.providerMeta.baseUrl;
  if (typeof base !== 'string' || !base) {
    throw new Error(`evogo channel ${ch.id} is missing providerMeta.baseUrl`);
  }
  // Trim a trailing slash so `${baseUrl}/send/text` never doubles up.
  return base.replace(/\/+$/, '');
}

function tokenOf(ch: ChannelCtx): string {
  const token = ch.credentials.token;
  if (typeof token !== 'string' || !token) {
    throw new Error(`evogo channel ${ch.id} is missing credentials.token`);
  }
  return token;
}

// ------------------------------------------------------------
// Small HTTP helper
// ------------------------------------------------------------

/**
 * POST/GET JSON against the EvoGo instance with the `apikey` auth header.
 * Returns the parsed JSON body (as `unknown` — callers narrow). Throws with
 * the upstream status + body snippet so a misconfigured instance surfaces a
 * legible error rather than a generic `fetch failed`.
 */
async function httpJson(
  ch: ChannelCtx,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  const url = `${baseUrlOf(ch)}${path}`;
  const method = init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(url, {
    method,
    headers: {
      apikey: tokenOf(ch),
      ...(init?.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `evogo ${method} ${path} failed: ${res.status} ${raw.slice(0, 300)}`,
    );
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Some endpoints (e.g. a bare QR string) may return non-JSON; hand back
    // the raw text so the caller can decide.
    return raw;
  }
}

// ------------------------------------------------------------
// Outbound number formatting
// ------------------------------------------------------------

/**
 * EvoGo's /send endpoints want the recipient as bare E.164 digits including
 * the Brazil country code (55). The unified interface hands us `toE164`
 * which may or may not already carry the 55, so normalize to digits and
 * prepend 55 when it's missing.
 */
function toEvoNumber(toE164: string): string {
  const digits = normalizePhone(toE164);
  return digits.startsWith('55') ? digits : `55${digits}`;
}

/** Pull the external message id out of a /send response, tolerating shapes. */
function externalIdFromSend(body: unknown): string {
  const b = (body ?? {}) as {
    data?: { Info?: { ID?: string } };
    id?: string;
    key?: { id?: string };
    messageId?: string;
  };
  return b.data?.Info?.ID ?? b.id ?? b.key?.id ?? b.messageId ?? '';
}

// ------------------------------------------------------------
// Webhook payload types
// ------------------------------------------------------------

interface EvoInfo {
  ID?: string;
  Chat?: string;
  Sender?: string;
  SenderAlt?: string;
  IsFromMe?: boolean;
  PushName?: string;
}

interface EvoMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  audioMessage?: { mimetype?: string };
  documentMessage?: {
    caption?: string;
    fileName?: string;
    mimetype?: string;
  };
}

interface EvoWebhookBody {
  event?: string;
  data?: {
    Info?: EvoInfo;
    Message?: EvoMessage;
    // Receipt payloads:
    State?: string;
    MessageIDs?: string[];
    MessageID?: string;
  };
}

// ------------------------------------------------------------
// Provider implementation
// ------------------------------------------------------------

export const evogoProvider: WhatsAppProvider = {
  id: 'evogo',
  capabilities: CAPABILITIES.evogo,

  async sendText(
    ch: ChannelCtx,
    toE164: string,
    text: string,
  ): Promise<{ externalMessageId: string }> {
    const body = await httpJson(ch, '/send/text', {
      body: { number: toEvoNumber(toE164), text },
    });
    return { externalMessageId: externalIdFromSend(body) };
  },

  async sendMedia(
    ch: ChannelCtx,
    toE164: string,
    media: OutboundMedia,
  ): Promise<{ externalMessageId: string }> {
    // EvoGo's /send/media accepts EITHER raw base64 OR a public https URL in
    // the same `url` field. Prefer base64 when present; otherwise pass the
    // public URL (our MinIO link) directly. `type` mirrors the media kind
    // (image | document | audio | video).
    const url = media.base64 ?? media.url;
    if (!url) {
      throw new Error(
        'evogo sendMedia requires media.base64 or media.url (public link).',
      );
    }
    const body = await httpJson(ch, '/send/media', {
      body: {
        number: toEvoNumber(toE164),
        url,
        type: media.kind, // 'image' | 'document' | 'audio' | 'video'
        caption: media.caption,
        filename: media.filename,
      },
    });
    return { externalMessageId: externalIdFromSend(body) };
  },

  async sendReaction(
    ch: ChannelCtx,
    targetExternalId: string,
    emoji: string,
  ): Promise<void> {
    // Best-effort: EvoGo exposes a /send/reaction endpoint on most builds.
    // The unified signature only gives us the target message id + emoji, so
    // we pass what we have and swallow failures (an unsupported build simply
    // 404s — reactions are a nice-to-have, not a delivery guarantee).
    try {
      await httpJson(ch, '/send/reaction', {
        body: { id: targetExternalId, reaction: emoji },
      });
    } catch (err) {
      console.warn(
        `[evogo] sendReaction best-effort failed for ${targetExternalId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  },

  // sendTemplate / sendInteractive intentionally omitted: EvoGo supports
  // neither (capabilities.templates = interactive = false).

  async verifyWebhook(
    ctx: WebhookVerifyCtx,
    ch: ChannelCtx | null,
  ): Promise<boolean> {
    // EvoGo has no HMAC signing. Instead the route
    // (/api/webhooks/evogo/[channelId]) resolves the channel and we verify a
    // shared secret: the instance is configured to send `x-webhook-secret`
    // and we compare it against the per-channel webhookSecret. No channel or
    // no configured secret → reject.
    if (!ch || !ch.webhookSecret) return false;
    const provided = ctx.headers.get('x-webhook-secret');
    return provided === ch.webhookSecret;
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const messages: NormalizedInbound[] = [];
    const statuses: NormalizedStatus[] = [];

    const parsed = body as EvoWebhookBody | null;
    if (!parsed || !parsed.data) return { messages, statuses };

    // ---- inbound messages ----
    if (parsed.event === 'Message') {
      const inbound = normalizeInboundMessage(parsed.data);
      if (inbound) messages.push(inbound);
    }

    // ---- delivery/read receipts ----
    if (parsed.event === 'Receipt') {
      statuses.push(...normalizeReceipt(parsed.data));
    }

    return { messages, statuses };
  },

  // fetchInboundMedia intentionally OMITTED. EvoGo delivers `base64: null`
  // for inbound media and exposes no fetch API to retrieve the bytes later —
  // there is nothing to resolve. This is the known structural limitation
  // (capabilities.inboundMedia = false); inbound media is surfaced as a text
  // placeholder in parseWebhook instead. (Alex confirmed this in RecebIA.)

  // ---- session lifecycle ----

  async startSession(
    ch: ChannelCtx,
    webhookUrl: string,
  ): Promise<{ qr?: string }> {
    // 1. Register the webhook. NOTE the quirk: calling /instance/connect
    //    RESETS the instance webhook, so it must only be called deliberately
    //    (here, at session start) — never on a hot path. subscribe:['ALL']
    //    delivers every event type (Message, Receipt, …).
    await httpJson(ch, '/instance/connect', {
      body: { webhookUrl, subscribe: ['ALL'] },
    });

    // 2. Fetch the pairing QR. EvoGo returns a QR *string* (starts with
    //    '2@…'), NOT an image — it's the raw payload the WhatsApp app scans.
    //    We return it as-is; the UI renders it into a QR code (e.g. via a
    //    qrcode canvas), it is not a data: image URL.
    const qrBody = (await httpJson(ch, '/instance/qr')) as {
      data?: { Qrcode?: string; Code?: string };
    };
    const qr = qrBody.data?.Qrcode || qrBody.data?.Code;
    return { qr: qr || undefined };
  },

  async getState(ch: ChannelCtx): Promise<{ status: string }> {
    const body = (await httpJson(ch, '/instance/status')) as {
      data?: { LoggedIn?: boolean; Connected?: boolean };
    };
    const loggedIn = !!(body.data?.LoggedIn || body.data?.Connected);
    return { status: loggedIn ? 'connected' : 'disconnected' };
  },
};

// ------------------------------------------------------------
// Inbound normalization
// ------------------------------------------------------------

/** JIDs we never ingest: groups (@g.us) and status broadcasts. */
function isIgnorableJid(jid: string): boolean {
  return jid.endsWith('@g.us') || jid.startsWith('status@');
}

/**
 * Turn one EvoGo `Message` event's `data` into a NormalizedInbound, or null
 * when it carries nothing we ingest (group, status, or fromMe we can't route).
 *
 * @lid resolution: inbound has the real phone in Chat/Sender and the @lid in
 * SenderAlt. We pick the first JID among Chat/Sender/SenderAlt that is NOT an
 * @lid, then take its local part (before '@') as the phone digits.
 */
function normalizeInboundMessage(data: {
  Info?: EvoInfo;
  Message?: EvoMessage;
}): NormalizedInbound | null {
  const info = data.Info;
  if (!info) return null;

  const fromMe = !!info.IsFromMe;

  // Filter groups / status broadcasts on any JID we can see.
  const chat = info.Chat ?? '';
  if (isIgnorableJid(chat)) return null;

  // fromMe echoes carry an @lid in Chat and NO real phone in the payload —
  // we'd need a persistent lid→phone map to route them. Skip for v1.
  // TODO: lid→phone map for fromMe (RecebIA's wa_lid_map) to mirror our sends.
  if (fromMe) return null;

  // Pick the real (non-@lid) JID from Chat / Sender / SenderAlt.
  const realJid = [info.Chat, info.Sender, info.SenderAlt].find(
    (j): j is string => typeof j === 'string' && !!j && !j.includes('@lid'),
  );
  if (!realJid || isIgnorableJid(realJid)) return null;

  const fromPhoneE164 = normalizePhone(realJid.split('@')[0]);
  if (!fromPhoneE164) return null;

  const base = {
    externalMessageId: info.ID ?? '',
    fromPhoneE164,
    fromMe: false,
    pushName: info.PushName || undefined,
  };

  const msg = data.Message ?? {};

  // Plain text.
  const text = msg.conversation ?? msg.extendedTextMessage?.text;
  if (typeof text === 'string' && text.length > 0) {
    return { ...base, contentType: 'text', contentText: text };
  }

  // Media: EvoGo delivers NO bytes and offers no fetch. Downgrade to a text
  // placeholder describing the media kind so the inbox shows something
  // readable instead of a broken tile. (capabilities.inboundMedia = false.)
  const mediaPlaceholder = mediaPlaceholderFor(msg);
  if (mediaPlaceholder) {
    return { ...base, contentType: 'text', contentText: mediaPlaceholder };
  }

  // Text-less, media-less (unsupported) event → keep it as an empty text row
  // rather than dropping it silently.
  return { ...base, contentType: 'text', contentText: null };
}

/**
 * Return a Portuguese placeholder for an inbound media message (or null if
 * the message carries no recognized media). Includes any caption so it isn't
 * lost, since EvoGo can't deliver the bytes.
 */
function mediaPlaceholderFor(msg: EvoMessage): string | null {
  let label: string | null = null;
  let caption: string | undefined;

  if (msg.imageMessage) {
    label = 'imagem';
    caption = msg.imageMessage.caption;
  } else if (msg.videoMessage) {
    label = 'vídeo';
    caption = msg.videoMessage.caption;
  } else if (msg.audioMessage) {
    label = 'áudio';
  } else if (msg.documentMessage) {
    label = 'documento';
    caption = msg.documentMessage.caption ?? msg.documentMessage.fileName;
  }

  if (!label) return null;

  const base = `[${label} recebido — EvoGo não entrega mídia]`;
  return caption ? `${base} ${caption}` : base;
}

/**
 * Turn a `Receipt` event into NormalizedStatus[]. EvoGo may batch multiple
 * message ids in `MessageIDs[]`, or send a single `MessageID`. State mapping:
 *   delivered      → level 2
 *   read | played  → level 3
 * Any other state is not surfaced.
 */
function normalizeReceipt(data: {
  State?: string;
  MessageIDs?: string[];
  MessageID?: string;
}): NormalizedStatus[] {
  const state = (data.State ?? '').toLowerCase();
  const level: 2 | 3 | null =
    state === 'delivered'
      ? 2
      : state === 'read' || state === 'played'
        ? 3
        : null;
  if (level === null) return [];

  const ids =
    Array.isArray(data.MessageIDs) && data.MessageIDs.length > 0
      ? data.MessageIDs
      : data.MessageID
        ? [data.MessageID]
        : [];

  return ids
    .filter((id): id is string => typeof id === 'string' && !!id)
    .map((id) => ({ externalMessageId: id, level }));
}

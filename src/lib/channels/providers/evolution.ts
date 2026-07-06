// ============================================================
// Evolution API provider adapter (Phase 4, wave 2).
//
// Implements `WhatsAppProvider` for provider 'evolution'. Evolution runs
// the Baileys engine (integration WHATSAPP-BAILEYS) and is a self-hosted,
// non-official transport bound by QR pairing. Unlike meta.ts (which
// delegates to existing helpers), Evolution has no pre-existing client, so
// every network call is made directly here through a small `httpJson`
// helper.
//
// Routing / auth (see docs/fase4-multicanal.md → "EVOLUTION API"):
//   * credentials JSON = `{ apiKey }`
//   * provider_meta    = `{ baseUrl, instance }`  (instance name goes in
//     the URL path; baseUrl is the Evolution server root)
//   * auth header      = `apikey: <apiKey>` on every request
//
// Media:
//   * Outbound — Evolution wants base64, not a public link. sendMedia
//     uses media.base64 when present, else fetches media.url and encodes
//     it. Audio has a dedicated endpoint (sendWhatsAppAudio, ogg/opus).
//   * Inbound — the webhook does NOT carry the bytes. parseWebhook emits a
//     `fetchKey` (the message key) and fetchInboundMedia resolves it via
//     `chat/getBase64FromMediaMessage`. This is the ONLY way to get inbound
//     media on Evolution.
//
// Webhook auth: Evolution does not sign the body. The wave-3 route at
//   /api/webhooks/evolution/[channelId]
// carries a per-channel token in the `x-webhook-secret` header; verifyWebhook
// compares it (constant work) against ch.webhookSecret.
//
// Sessions: QR pairing (capabilities.qrPairing = true). startSession creates
// the instance (idempotent), wires the webhook, and returns the QR data URL;
// getState maps the Baileys connection state onto our status vocabulary.
//
// See docs/fase4-multicanal.md → "EVOLUTION API".
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
// credentials JSON for evolution is `{ apiKey }`; provider_meta is
// `{ baseUrl, instance }`. Pull the three things every call needs with a
// clear error if the channel row is misconfigured.

function apiKeyOf(ch: ChannelCtx): string {
  const key = ch.credentials.apiKey;
  if (typeof key !== 'string' || !key) {
    throw new Error(`evolution channel ${ch.id} is missing credentials.apiKey`);
  }
  return key;
}

function baseUrlOf(ch: ChannelCtx): string {
  const url = ch.providerMeta.baseUrl;
  if (typeof url !== 'string' || !url) {
    throw new Error(
      `evolution channel ${ch.id} is missing providerMeta.baseUrl`,
    );
  }
  // Trim a trailing slash so `${baseUrl}/message/...` never doubles up.
  return url.replace(/\/+$/, '');
}

function instanceOf(ch: ChannelCtx): string {
  const inst = ch.providerMeta.instance;
  if (typeof inst !== 'string' || !inst) {
    throw new Error(
      `evolution channel ${ch.id} is missing providerMeta.instance`,
    );
  }
  return inst;
}

// ------------------------------------------------------------
// Small HTTP helper
// ------------------------------------------------------------

/**
 * POST/GET JSON to Evolution with the `apikey` auth header. Throws on a
 * non-2xx response (including the upstream body for debugging). `body` is
 * omitted for GETs.
 */
async function httpJson(
  ch: ChannelCtx,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${baseUrlOf(ch)}${path}`, {
    method,
    headers: {
      apikey: apiKeyOf(ch),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw new Error(
      `evolution ${method} ${path} failed (${res.status}): ${detail}`,
    );
  }
  return parsed;
}

/** Fetch a public media URL and return its base64 body. */
async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`evolution: failed to fetch media url (${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

/** Evolution wants E.164 digits (no @c.us) — it derives the JID itself. */
function toNumber(toE164: string): string {
  return normalizePhone(toE164);
}

// ------------------------------------------------------------
// Webhook payload types
// ------------------------------------------------------------

interface EvoKey {
  id?: string;
  remoteJid?: string;
  fromMe?: boolean;
}

interface EvoMessageContent {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  imageMessage?: { caption?: string; mimetype?: string };
  videoMessage?: { caption?: string; mimetype?: string };
  audioMessage?: { mimetype?: string };
  documentMessage?: {
    caption?: string;
    mimetype?: string;
    fileName?: string;
  };
}

interface EvoUpsertData {
  key?: EvoKey;
  message?: EvoMessageContent;
  pushName?: string;
}

interface EvoUpdateData {
  keyId?: string;
  key?: EvoKey;
  status?: string | number;
  update?: { status?: string | number };
}

interface EvoWebhookBody {
  event?: string;
  data?: EvoUpsertData & EvoUpdateData;
}

// ------------------------------------------------------------
// Provider implementation
// ------------------------------------------------------------

export const evolutionProvider: WhatsAppProvider = {
  id: 'evolution',
  capabilities: CAPABILITIES.evolution,

  async sendText(
    ch: ChannelCtx,
    toE164: string,
    text: string,
  ): Promise<{ externalMessageId: string }> {
    const body = await httpJson(
      ch,
      'POST',
      `/message/sendText/${instanceOf(ch)}`,
      { number: toNumber(toE164), text },
    );
    return { externalMessageId: extractSentId(body) };
  },

  async sendMedia(
    ch: ChannelCtx,
    toE164: string,
    media: OutboundMedia,
  ): Promise<{ externalMessageId: string }> {
    const number = toNumber(toE164);

    // Evolution needs the bytes as base64 — prefer an inline payload, else
    // download the public URL and encode it.
    const base64 =
      media.base64 ?? (media.url ? await urlToBase64(media.url) : undefined);
    if (!base64) {
      throw new Error(
        'evolution sendMedia requires media.base64 or media.url to source the bytes.',
      );
    }

    // Audio rides its own endpoint (voice note; ogg/opus expected).
    if (media.kind === 'audio') {
      const body = await httpJson(
        ch,
        'POST',
        `/message/sendWhatsAppAudio/${instanceOf(ch)}`,
        { number, audio: base64 },
      );
      return { externalMessageId: extractSentId(body) };
    }

    // image / document / video → sendMedia with a mediatype discriminator.
    const body = await httpJson(
      ch,
      'POST',
      `/message/sendMedia/${instanceOf(ch)}`,
      {
        number,
        mediatype: media.kind, // 'image' | 'document' | 'video'
        mimetype: media.mimetype,
        media: base64,
        fileName: media.filename,
        caption: media.caption,
      },
    );
    return { externalMessageId: extractSentId(body) };
  },

  async sendReaction(
    ch: ChannelCtx,
    targetExternalId: string,
    emoji: string,
  ): Promise<void> {
    // Best-effort: Evolution's reaction endpoint wants the full message key,
    // but the unified sendReaction signature only carries the target id. We
    // route through providerMeta.reaction_remote_jid (threaded by the wave-3
    // outbound funnel) when available; if the key can't be assembled we skip
    // rather than throw, since reactions are non-critical.
    const remoteJid = ch.providerMeta.reaction_remote_jid;
    if (typeof remoteJid !== 'string' || !remoteJid) return;
    try {
      await httpJson(ch, 'POST', `/message/sendReaction/${instanceOf(ch)}`, {
        key: { id: targetExternalId, remoteJid, fromMe: true },
        reaction: emoji,
      });
    } catch (err) {
      console.error(
        `[evolution] sendReaction failed for ${targetExternalId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  },

  async verifyWebhook(
    ctx: WebhookVerifyCtx,
    ch: ChannelCtx | null,
  ): Promise<boolean> {
    // Evolution does not sign the payload. Instead the wave-3 route
    // (/api/webhooks/evolution/[channelId]) attaches a per-channel token in
    // the `x-webhook-secret` header, which we compare against the channel's
    // stored webhook_secret. Reject when the channel is unknown or the
    // header is missing/mismatched.
    if (!ch || !ch.webhookSecret) return false;
    const provided = ctx.headers.get('x-webhook-secret');
    return provided != null && provided === ch.webhookSecret;
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const messages: NormalizedInbound[] = [];
    const statuses: NormalizedStatus[] = [];

    const parsed = body as EvoWebhookBody | null;
    if (!parsed || typeof parsed !== 'object') {
      return { messages, statuses };
    }

    const event = parsed.event;

    // ---- inbound messages / self-echoes ----
    if (event === 'MESSAGES_UPSERT') {
      const inbound = normalizeUpsert(parsed.data);
      if (inbound) messages.push(inbound);
      return { messages, statuses };
    }

    // ---- delivery / read receipts ----
    if (event === 'MESSAGES_UPDATE') {
      const status = normalizeUpdate(parsed.data);
      if (status) statuses.push(status);
      return { messages, statuses };
    }

    return { messages, statuses };
  },

  async fetchInboundMedia(
    ch: ChannelCtx,
    fetchKey: unknown,
  ): Promise<{ base64: string; mimetype: string } | null> {
    // The webhook never carries inbound bytes on Evolution — this fetch is
    // mandatory. fetchKey is `{ key }` (the message key) emitted by
    // parseWebhook. Ask Evolution to decode+return the media as base64.
    // Returns null on failure so a media hiccup never drops the message.
    const key = (fetchKey as { key?: unknown } | null)?.key;
    if (!key) return null;
    try {
      const body = await httpJson(
        ch,
        'POST',
        `/chat/getBase64FromMediaMessage/${instanceOf(ch)}`,
        { message: { key }, convertToMp4: false },
      );
      if (!body || typeof body.base64 !== 'string' || !body.base64) {
        return null;
      }
      return {
        base64: body.base64,
        mimetype:
          typeof body.mimetype === 'string' && body.mimetype
            ? body.mimetype
            : 'application/octet-stream',
      };
    } catch (err) {
      console.error(
        `[evolution] fetchInboundMedia failed:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },

  async startSession(
    ch: ChannelCtx,
    webhookUrl: string,
  ): Promise<{ qr?: string }> {
    const instance = instanceOf(ch);

    // 1. Create the instance if it doesn't exist yet. Evolution 409s (or
    //    returns an error body) when the instance already exists — that's
    //    fine, we just want it present, so swallow that specific failure.
    try {
      await httpJson(ch, 'POST', `/instance/create`, {
        instanceName: instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already\s*(in use|exists)/i.test(msg)) throw err;
    }

    // 2. Wire the webhook to our route, subscribed to the two events we
    //    parse. byEvents:false = one flat URL for all events.
    await httpJson(ch, 'POST', `/webhook/set/${instance}`, {
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE'],
      },
    });

    // 3. Ask for the QR to pair. base64 is a data:image/png the UI renders.
    const body = await httpJson(ch, 'GET', `/instance/connect/${instance}`);
    const qr = body?.base64 ?? body?.qrcode?.base64;
    return { qr: typeof qr === 'string' ? qr : undefined };
  },

  async getState(ch: ChannelCtx): Promise<{ status: string }> {
    const body = await httpJson(
      ch,
      'GET',
      `/instance/connectionState/${instanceOf(ch)}`,
    );
    const state = body?.instance?.state ?? body?.state;
    return { status: mapConnectionState(state) };
  },
};

// ------------------------------------------------------------
// Inbound normalization
// ------------------------------------------------------------

const MEDIA_KINDS: Array<{
  field: keyof EvoMessageContent;
  kind: string;
  contentType: NormalizedInbound['contentType'];
}> = [
  { field: 'imageMessage', kind: 'image', contentType: 'image' },
  { field: 'audioMessage', kind: 'audio', contentType: 'audio' },
  { field: 'videoMessage', kind: 'video', contentType: 'video' },
  { field: 'documentMessage', kind: 'document', contentType: 'document' },
];

/**
 * Turn a MESSAGES_UPSERT `data` into a NormalizedInbound, or null when it's
 * not a direct message we ingest (groups, broadcasts, status, or empty).
 *
 * jid = key.remoteJid; direct chats end in @s.whatsapp.net. We drop
 * @g.us (groups), @broadcast, and status@broadcast. The phone is the
 * digits before '@'. Media is emitted as a `fetchKey: { key }` — the bytes
 * are pulled later by fetchInboundMedia.
 */
function normalizeUpsert(
  data: EvoUpsertData | undefined,
): NormalizedInbound | null {
  const key = data?.key;
  const jid = key?.remoteJid;
  if (!key || !key.id || !jid) return null;

  // Filter out non-direct chats: groups, broadcast lists, status updates.
  // Also drop a bare numeric group/newsletter id that lost its suffix (16+
  // digits — an E.164 phone is at most 15).
  if (
    jid.endsWith('@g.us') ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter') ||
    jid.startsWith('status@') ||
    /^\d{16,}$/.test(jid.split('@')[0])
  ) {
    return null;
  }

  const fromPhoneE164 = normalizePhone(jid.split('@')[0]);
  if (!fromPhoneE164) return null;

  const msg = data?.message ?? {};
  const base = {
    externalMessageId: key.id,
    fromPhoneE164,
    fromMe: !!key.fromMe,
    pushName: data?.pushName || undefined,
  };

  // Any recognized media part → media inbound (text becomes the caption).
  for (const { field, kind, contentType } of MEDIA_KINDS) {
    const part = msg[field] as
      | { caption?: string; mimetype?: string; fileName?: string }
      | undefined;
    if (part) {
      return {
        ...base,
        contentType,
        contentText: part.caption ?? null,
        media: {
          kind,
          mimetype: part.mimetype,
          filename: part.fileName,
          // The webhook has no bytes — fetchInboundMedia resolves this key.
          fetchKey: { key },
        },
      };
    }
  }

  // Plain text: `conversation` or the extended-text variant.
  const text =
    msg.conversation ?? msg.extendedTextMessage?.text ?? null;

  // Nothing we ingest (e.g. a system/protocol message).
  if (text == null) return null;

  return { ...base, contentType: 'text', contentText: text };
}

/**
 * Turn a MESSAGES_UPDATE `data` into a NormalizedStatus, or null when the
 * update isn't a delivered/read receipt. Evolution reports either a string
 * status (DELIVERY_ACK / DELIVERED / READ / PLAYED) or the numeric Baileys
 * ack (2 = delivered, 3 = read, 4 = played). We map both onto our 2/3 levels.
 */
function normalizeUpdate(
  data: EvoUpdateData | undefined,
): NormalizedStatus | null {
  if (!data) return null;
  const id = data.keyId || data.key?.id;
  if (!id) return null;

  const raw = data.status ?? data.update?.status;
  const level = statusLevel(raw);
  if (level === null) return null;

  return { externalMessageId: id, level };
}

/** Map an Evolution/Baileys status onto our 2 (delivered) / 3 (read) levels. */
function statusLevel(raw: string | number | undefined): 2 | 3 | null {
  if (raw == null) return null;
  const s = typeof raw === 'string' ? raw.toUpperCase() : raw;
  if (s === 'READ' || s === 'PLAYED' || s === 3 || s === 4) return 3;
  if (s === 'DELIVERY_ACK' || s === 'DELIVERED' || s === 2) return 2;
  return null;
}

// ------------------------------------------------------------
// Session-state mapping
// ------------------------------------------------------------

/** Map Baileys connection state → our status vocabulary. */
function mapConnectionState(state: unknown): string {
  switch (state) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'qr_pending';
    case 'close':
      return 'disconnected';
    default:
      return 'disconnected';
  }
}

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

/**
 * Pull the provider-side message id from a send response. Evolution returns
 * the Baileys key (`key.id`); some builds surface `messageId` instead.
 */
function extractSentId(body: any): string {
  const id = body?.key?.id ?? body?.messageId;
  if (typeof id !== 'string' || !id) {
    throw new Error(
      `evolution send: response missing message id (key.id / messageId)`,
    );
  }
  return id;
}

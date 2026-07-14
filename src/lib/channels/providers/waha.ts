// ============================================================
// WAHA (WhatsApp HTTP API — https://waha.devlike.pro) provider adapter
// (Phase 4, wave 2).
//
// Implements `WhatsAppProvider` for provider 'waha'. Unlike the Meta
// adapter (which delegates to meta-api.ts), WAHA has no pre-existing
// helper module in this codebase, so this file talks to the WAHA REST
// API directly through a small `httpJson` helper (fetch + JSON + timeout),
// mirroring RecebIA's battle-tested WahaAdapter.js.
//
// Engine: NOWEB. WEBJS breaks with "No LID" on the privacy token WhatsApp
// now requires, so — per RecebIA — we stay on NOWEB throughout.
//
// Auth: `X-Api-Key: <apiKey>`. Routing comes off ChannelCtx:
//   * ch.credentials.apiKey        → the X-Api-Key value
//   * ch.providerMeta.baseUrl      → the WAHA server base URL
//   * ch.providerMeta.session      → the session name
//
// Key quirks handled here (all quoted from the cheat-sheet /
// docs/fase4-multicanal.md → "WAHA"):
//   * 9th-digit fix: resolveChatId() does a check-exists round-trip so the
//     Brazilian extra "9" doesn't send to a dead JID.
//   * @lid privacy addressing: parseWebhook prefers _data.key.remoteJidAlt
//     (@s.whatsapp.net) when the primary chat is @lid.
//   * inbound media host rewrite: WAHA returns media URLs with an internal
//     host (localhost:3000) → fetchInboundMedia rewrites it to baseUrl.
//   * serialized ids "true_<chat>_<HASH>" → normalized to the last _-segment
//     so send / ack / inbound all key on the same id.
//
// Sessions: WAHA uses QR pairing (capabilities.qrPairing = true), so
// startSession + getState are implemented (unlike Meta).
//
// Webhook secret mechanism: WAHA can't sign the body like Meta, so
// verifyWebhook matches the per-channel `ch.webhookSecret` against the
// `x-webhook-secret` REQUEST HEADER. The wave-3 webhook route is expected
// to configure the WAHA session's webhook so that WAHA sends this header
// (WAHA supports custom webhook headers), OR — if header injection isn't
// available — the route itself reads a `?secret=` query param and performs
// the comparison before delegating. This adapter only compares the header,
// because verifyWebhook receives just rawBody + headers (no URL/query).
// ============================================================

import { CAPABILITIES } from '../provider';
import type {
  ChannelCtx,
  NormalizedInbound,
  NormalizedStatus,
  OutboundMedia,
  ParsedWebhook,
  SendOptions,
  WebhookVerifyCtx,
  WhatsAppProvider,
} from '../provider';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

// ------------------------------------------------------------
// httpJson — fetch + JSON + timeout (ported from RecebIA)
// ------------------------------------------------------------

interface HttpJsonResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | { raw: string };
}

async function httpJson(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<HttpJsonResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body: HttpJsonResult['body'];
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------
// ChannelCtx → WAHA routing extraction
// ------------------------------------------------------------
//
// credentials JSON for waha is `{ apiKey }`; provider_meta is
// `{ baseUrl, session }` (see the cheat-sheet schema).

function baseUrlOf(ch: ChannelCtx): string {
  const base = ch.providerMeta.baseUrl;
  if (typeof base !== 'string' || !base) {
    throw new Error(`waha channel ${ch.id} is missing providerMeta.baseUrl`);
  }
  // Trailing slashes would double up when we append `/api/...`.
  return base.replace(/\/+$/, '');
}

function sessionOf(ch: ChannelCtx): string {
  const session = ch.providerMeta.session;
  return typeof session === 'string' && session ? session : 'default';
}

function apiKeyOf(ch: ChannelCtx): string {
  const key = ch.credentials.apiKey;
  return typeof key === 'string' ? key : '';
}

function headersOf(ch: ChannelCtx): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Api-Key': apiKeyOf(ch) };
}

// ------------------------------------------------------------
// id + base64 normalization helpers
// ------------------------------------------------------------

/**
 * Extract the provider-side message id from a WAHA send response.
 * NOWEB returns it in key.id; WEBJS in id (string or {_serialized}).
 * Then normalize the serialized `true_<chat>_<HASH>` form to its final
 * `_`-segment so send / ack / inbound all key on the same id.
 */
function extractExternalId(body: Record<string, unknown>): string | undefined {
  const key = body.key as { id?: unknown } | undefined;
  const dataObj = body._data as { id?: unknown } | undefined;
  const raw = body.id ?? key?.id ?? dataObj?.id;
  const asString = serializedIdToString(raw);
  if (!asString) return undefined;
  return normalizeSerializedId(asString);
}

/** A WAHA id can be a string or an object carrying `_serialized`/`id`. */
function serializedIdToString(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const o = raw as { _serialized?: unknown; id?: unknown };
    if (typeof o._serialized === 'string') return o._serialized;
    if (typeof o.id === 'string') return o.id;
  }
  return null;
}

/** `true_<chat>_<HASH>` → `<HASH>` (last `_`-segment). Plain ids pass through. */
function normalizeSerializedId(id: string): string {
  return id.split('_').pop() || id;
}

/** Strip a `data:...;base64,` prefix — WAHA wants raw base64. */
function rawBase64(b64: string): string {
  return String(b64 || '').replace(/^data:[^;]+;base64,/, '');
}

// ------------------------------------------------------------
// resolveChatId — the 9th-digit fix
// ------------------------------------------------------------

/**
 * Resolve the CANONICAL chatId for a phone via WhatsApp (check-exists).
 * Critical in Brazil because of the "9th digit": the dialed number
 * (e.g. 5567 9 92539584) often has a different WhatsApp id (5567 92539584,
 * without the extra 9). Sending to the wrong JID makes the message "send"
 * but never arrive — so we always resolve BEFORE sending.
 *
 *   GET {baseUrl}/api/contacts/check-exists?phone={digits}&session={session}
 *   → body.chatId when body.numberExists; fallback `${digits}@c.us`.
 */
async function resolveChatId(ch: ChannelCtx, toE164: string): Promise<string> {
  const digits = normalizePhone(toE164);
  const base = baseUrlOf(ch);
  const session = sessionOf(ch);
  try {
    const { ok, body } = await httpJson(
      `${base}/api/contacts/check-exists?phone=${encodeURIComponent(
        digits,
      )}&session=${encodeURIComponent(session)}`,
      { method: 'GET', headers: headersOf(ch) },
    );
    const b = body as { numberExists?: unknown; chatId?: unknown };
    if (ok && b.numberExists && typeof b.chatId === 'string' && b.chatId) {
      return b.chatId;
    }
  } catch {
    /* fall through to the fallback */
  }
  return `${digits}@c.us`;
}

/**
 * POST with a single retry: right after pairing, NOWEB still syncs for a
 * few seconds and returns 422 "Session status is not as expected" — wait
 * and retry once. (Ported from RecebIA's `_send`.)
 */
async function sendWithRetry(
  ch: ChannelCtx,
  endpoint: string,
  payload: unknown,
): Promise<HttpJsonResult> {
  const base = baseUrlOf(ch);
  const doPost = () =>
    httpJson(`${base}/api/${endpoint}`, {
      method: 'POST',
      headers: headersOf(ch),
      body: JSON.stringify(payload),
    });
  let r = await doPost();
  if (!r.ok && /not as expected|STARTING|SCAN_QR/i.test(JSON.stringify(r.body || ''))) {
    await sleep(2500);
    r = await doPost();
  }
  return r;
}

function wahaError(body: HttpJsonResult['body'], status: number): string {
  if (body) {
    const b = body as Record<string, unknown>;
    const m =
      b.error ??
      b.message ??
      (b.response as { message?: unknown } | undefined)?.message ??
      b;
    const out = (
      typeof m === 'string'
        ? m
        : (() => {
            try {
              return JSON.stringify(m);
            } catch {
              return String(m);
            }
          })()
    ).trim();
    if (out && out !== '{}' && out !== 'null') return out.slice(0, 300);
  }
  return `HTTP ${status}`;
}

// ------------------------------------------------------------
// Webhook payload types
// ------------------------------------------------------------

interface WahaMediaPayload {
  mimetype?: string;
  url?: string;
  filename?: string;
}

interface WahaMessagePayload {
  id?: unknown;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  caption?: string;
  hasMedia?: boolean;
  media?: WahaMediaPayload;
  ack?: number;
  viewOnce?: boolean;
  _data?: {
    // WAHA NOWEB flags view-once here: `_data.key.isViewOnce` (confirmed
    // against a real payload — the media itself is withheld).
    key?: { remoteJidAlt?: string; isViewOnce?: boolean };
    // GOWS (whatsmeow) engine — waha-voip: raw Go Info struct. With native
    // @lid addressing the real phone lives in Info.SenderAlt (inbound) /
    // Info.RecipientAlt (fromMe echoes), both @s.whatsapp.net (confirmed
    // against a real waha-voip payload).
    Info?: {
      Chat?: string;
      SenderAlt?: string;
      RecipientAlt?: string;
      PushName?: string;
    };
    pushName?: string;
    notifyName?: string;
    viewOnce?: boolean;
    body?: string;
    // Raw Baileys message node — for fromMe echoes `p.body` is empty and the
    // text lives here (`conversation` / `extendedTextMessage.text`).
    message?: Record<string, unknown>;
    // GOWS puts the same node at `Message` (Go struct, capital M) and flags
    // view-once at the _data root.
    Message?: Record<string, unknown>;
    IsViewOnce?: boolean;
  };
  notifyName?: string;
}

/** Extract the text of a WAHA message. For fromMe echoes `p.body` is empty,
 *  so fall back to the raw Baileys node (NOWEB). */
function textOfPayload(p: WahaMessagePayload): string {
  if (p.body) return p.body;
  if (p.caption) return p.caption;
  const d = p._data;
  if (typeof d?.body === 'string' && d.body) return d.body;
  // Raw message node: NOWEB/Baileys puts it at `_data.message` (lowercase);
  // GOWS/whatsmeow (waha-voip) at `_data.Message` (Go struct, capital M).
  const m = (d?.message ?? d?.Message) as
    | {
        conversation?: unknown;
        extendedTextMessage?: { text?: unknown };
      }
    | undefined;
  if (typeof m?.conversation === 'string' && m.conversation) return m.conversation;
  if (typeof m?.extendedTextMessage?.text === 'string') {
    return m.extendedTextMessage.text;
  }
  return '';
}

/** Extract legible text from a WhatsApp `interactiveMessage` (NOWEB). Handles
 *  the Pix key card (nativeFlowMessage → payment_info → pix_static_code) and
 *  falls back to any body/header title. Empty when it's not something we can
 *  render as text. The PIX_PREFIX marker lets the bubble render a copy card. */
export const PIX_PREFIX = '💠 Chave Pix';
interface InteractiveNode {
  // GOWS wraps the proto one level deeper: interactiveMessage.InteractiveMessage
  InteractiveMessage?: InteractiveNode;
  // Baileys: nativeFlowMessage/buttonParamsJson; GOWS: NativeFlowMessage/
  // buttonParamsJSON (confirmed against a real waha-voip Pix payload).
  nativeFlowMessage?: {
    buttons?: Array<{ name?: string; buttonParamsJson?: string; buttonParamsJSON?: string }>;
  };
  NativeFlowMessage?: {
    buttons?: Array<{ name?: string; buttonParamsJson?: string; buttonParamsJSON?: string }>;
  };
  body?: { text?: string };
  header?: { title?: string };
}

function textFromInteractive(p: WahaMessagePayload): string {
  // `_data.message` = NOWEB/Baileys; `_data.Message` = GOWS (waha-voip).
  let im = ((p._data?.message ?? p._data?.Message) as
    | { interactiveMessage?: unknown }
    | undefined)?.interactiveMessage as InteractiveNode | undefined;
  if (!im) return '';
  // GOWS nests the actual node one level down.
  if (im.InteractiveMessage) im = im.InteractiveMessage;
  const flow = im.nativeFlowMessage ?? im.NativeFlowMessage;
  for (const b of flow?.buttons ?? []) {
    const raw = b.buttonParamsJson ?? b.buttonParamsJSON;
    if (!raw) continue;
    try {
      const params = JSON.parse(raw) as {
        payment_settings?: Array<{
          pix_static_code?: {
            merchant_name?: string;
            key?: string;
            key_type?: string;
          };
        }>;
      };
      for (const s of params.payment_settings ?? []) {
        const pix = s.pix_static_code;
        if (pix?.key) {
          const kt = pix.key_type ? ` • ${pix.key_type}` : '';
          const name = pix.merchant_name ? `\n${pix.merchant_name}` : '';
          return `${PIX_PREFIX}${kt}${name}\n${pix.key}`;
        }
      }
    } catch {
      // malformed JSON — ignore this button
    }
  }
  return im.body?.text || im.header?.title || '';
}

/**
 * Detect a WhatsApp "view once" message. WAHA NOWEB sets
 * `_data.key.isViewOnce` (and delivers no media/body for it). The extra
 * checks are cheap fallbacks for other engines/shapes.
 */
function detectViewOnce(p: WahaMessagePayload): boolean {
  return (
    p._data?.key?.isViewOnce === true ||
    p.viewOnce === true ||
    p._data?.viewOnce === true ||
    p._data?.IsViewOnce === true // GOWS (waha-voip)
  );
}

interface WahaWebhookBody {
  event?: string;
  session?: string;
  payload?: WahaMessagePayload;
}

// ------------------------------------------------------------
// inbound classification helpers
// ------------------------------------------------------------

const LID_RE = /@lid$/i;
const WA_NET_RE = /@s\.whatsapp\.net$/i;

/**
 * Groups, newsletters and status broadcasts are ignored in v1.
 *
 * We match both the suffixed form (`@g.us` / `@newsletter` / `@broadcast`)
 * AND the bare id shape: WAHA NOWEB sometimes delivers a group message with
 * the chat as a raw numeric id (e.g. `120363400053019227`) with no `@g.us`
 * suffix. WhatsApp group/newsletter ids are long (18+ digits, usually
 * prefixed `120363`), while an E.164 phone is at most 15 digits — so a bare
 * numeric local part of 16+ digits is a group/newsletter that lost its suffix.
 */
function isNonDirectJid(jid: string): boolean {
  if (
    /@g\.us$/i.test(jid) ||
    /@broadcast$/i.test(jid) ||
    /@newsletter$/i.test(jid) ||
    jid.startsWith('status@')
  ) {
    return true;
  }
  const local = jid.split('@')[0];
  // Bare numeric id too long to be a phone (E.164 max = 15 digits) → group.
  return /^\d{16,}$/.test(local);
}

/** Map a media mimetype to a NormalizedInbound.contentType-ish kind. */
function kindOfMime(mimetype: string): string {
  const mt = mimetype.toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('video/')) return 'video';
  return 'document';
}

// ------------------------------------------------------------
// Provider implementation
// ------------------------------------------------------------

export const wahaProvider: WhatsAppProvider = {
  id: 'waha',
  capabilities: CAPABILITIES.waha,

  async sendText(
    ch: ChannelCtx,
    toE164: string,
    text: string,
    _opts?: SendOptions,
  ): Promise<{ externalMessageId: string }> {
    const chatId = await resolveChatId(ch, toE164);
    const { ok, status, body } = await sendWithRetry(ch, 'sendText', {
      session: sessionOf(ch),
      chatId,
      text,
    });
    if (!ok) {
      throw new Error(`waha sendText failed: ${wahaError(body, status)}`);
    }
    const externalMessageId = extractExternalId(body as Record<string, unknown>);
    if (!externalMessageId) {
      throw new Error('waha sendText: response carried no message id');
    }
    return { externalMessageId };
  },

  async sendMedia(
    ch: ChannelCtx,
    toE164: string,
    media: OutboundMedia,
  ): Promise<{ externalMessageId: string }> {
    const chatId = await resolveChatId(ch, toE164);

    // Route by kind to the right endpoint + default mimetype (cheat-sheet).
    const kind = media.kind;
    const endpoint =
      kind === 'image'
        ? 'sendImage'
        : kind === 'audio'
          ? 'sendVoice'
          : kind === 'video'
            ? 'sendVideo'
            : 'sendFile';
    const defaultMime =
      kind === 'image'
        ? 'image/jpeg'
        : kind === 'audio'
          ? 'audio/ogg; codecs=opus'
          : kind === 'video'
            ? 'video/mp4'
            : 'application/octet-stream';

    // WAHA needs base64: use media.base64 if present, else fetch media.url
    // (the MinIO public URL) and encode it.
    const data = await resolveMediaBase64(media);
    if (!data) {
      throw new Error(
        'waha sendMedia requires media.base64 or a fetchable media.url',
      );
    }

    const payload: {
      session: string;
      chatId: string;
      file: { mimetype: string; filename: string; data: string };
      caption?: string;
    } = {
      session: sessionOf(ch),
      chatId,
      file: {
        mimetype: media.mimetype || defaultMime,
        filename: media.filename || 'arquivo',
        data,
      },
    };
    // sendVoice ignores caption.
    if (media.caption && endpoint !== 'sendVoice') {
      payload.caption = media.caption;
    }

    const { ok, status, body } = await sendWithRetry(ch, endpoint, payload);
    if (!ok) {
      throw new Error(`waha sendMedia failed: ${wahaError(body, status)}`);
    }
    const externalMessageId = extractExternalId(body as Record<string, unknown>);
    if (!externalMessageId) {
      throw new Error('waha sendMedia: response carried no message id');
    }
    return { externalMessageId };
  },

  async sendReaction(
    ch: ChannelCtx,
    targetExternalId: string,
    emoji: string,
  ): Promise<void> {
    // Best-effort: WAHA exposes PUT /api/reaction { session, messageId,
    // reaction }. Reactions are non-critical, so we swallow errors.
    try {
      await httpJson(`${baseUrlOf(ch)}/api/reaction`, {
        method: 'PUT',
        headers: headersOf(ch),
        body: JSON.stringify({
          session: sessionOf(ch),
          messageId: targetExternalId,
          reaction: emoji,
        }),
      });
    } catch (err) {
      console.error(
        `[waha] sendReaction failed for ${targetExternalId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  },

  // sendTemplate / sendInteractive intentionally omitted:
  // capabilities.templates and capabilities.interactive are both false.

  async verifyWebhook(
    ctx: WebhookVerifyCtx,
    ch: ChannelCtx | null,
  ): Promise<boolean> {
    // Non-Meta: WAHA can't HMAC-sign the body, so we match the per-channel
    // webhook_secret against the `x-webhook-secret` header. The wave-3 route
    // is expected to configure the WAHA webhook to send this header (WAHA
    // supports custom webhook headers). If a channel has no secret set, we
    // reject rather than accept-all.
    if (!ch || !ch.webhookSecret) return false;
    const provided = ctx.headers.get('x-webhook-secret');
    return typeof provided === 'string' && provided === ch.webhookSecret;
  },

  parseWebhook(body: unknown): ParsedWebhook {
    const messages: NormalizedInbound[] = [];
    const statuses: NormalizedStatus[] = [];

    const b = body as WahaWebhookBody | null;
    if (!b || typeof b !== 'object') return { messages, statuses };

    const event = String(b.event || '');
    const p = b.payload || {};

    // ---- delivery/read receipts (message.ack) ----
    if (event === 'message.ack') {
      const ack = Number(p.ack);
      const level = ack >= 3 ? 3 : ack === 2 ? 2 : null;
      if (level !== null) {
        const raw = serializedIdToString(p.id);
        const id = raw ? normalizeSerializedId(raw) : null;
        if (id) statuses.push({ externalMessageId: id, level });
      }
      return { messages, statuses };
    }

    // ---- session lifecycle: handled by the route, not here ----
    if (event === 'session.status') {
      return { messages, statuses };
    }

    // ---- inbound messages: 'message' (incoming) + 'message.any' (all) ----
    if (event === 'message' || event === 'message.any') {
      const fromMe = !!p.fromMe;
      // On 'message.any' only the fromMe echoes are new — incoming ones
      // already arrived via 'message', so skip non-fromMe here to avoid
      // storing the same inbound twice.
      if (event === 'message.any' && !fromMe) return { messages, statuses };

      // @lid privacy addressing: the real phone lives in an "alt" field —
      // NOWEB/Baileys: _data.key.remoteJidAlt; GOWS/whatsmeow (waha-voip):
      // _data.Info.SenderAlt (inbound) / Info.RecipientAlt (fromMe echoes).
      // Prefer the alt when the primary chat is @lid; otherwise a @lid-only
      // chat is non-direct.
      const info = p._data?.Info;
      // (fromMe: Sender = us, so SenderAlt would be OUR number — only
      // RecipientAlt identifies the customer there.)
      const alt = String(
        p._data?.key?.remoteJidAlt ||
          (fromMe ? info?.RecipientAlt : info?.SenderAlt) ||
          '',
      );
      // NOWEB puts the contact in `from` for both incoming and fromMe;
      // WEBJS used `to` for fromMe — keep it as a fallback.
      let chat = String(p.from || p.to || '');
      if (LID_RE.test(chat) && WA_NET_RE.test(alt)) chat = alt;
      if (!chat || isNonDirectJid(chat) || LID_RE.test(chat)) {
        // groups / status / @lid without an alt → drop.
        return { messages, statuses };
      }

      let text = textOfPayload(p);
      // WhatsApp Pix key cards arrive as an interactiveMessage with no body —
      // extract the key so it renders instead of an empty [text].
      if (!text) text = textFromInteractive(p);
      const raw = serializedIdToString(p.id);
      const externalMessageId = raw ? normalizeSerializedId(raw) : '';
      // GOWS alts carry the multi-device suffix ("556…5477:9@s.whatsapp.net");
      // strip it BEFORE normalizing or the digits gain a phantom tail and
      // spawn a duplicate contact + conversation.
      const fromPhoneE164 = normalizePhone(chat.split('@')[0].split(':')[0]);
      const pushName =
        p._data?.pushName ||
        p._data?.notifyName ||
        p.notifyName ||
        info?.PushName ||
        undefined;

      const viewOnce = detectViewOnce(p);
      let media: NormalizedInbound['media'] | undefined;
      let contentType: NormalizedInbound['contentType'] = 'text';
      if (p.hasMedia || p.media) {
        const mimetype = p.media?.mimetype || 'application/octet-stream';
        const kind = kindOfMime(mimetype);
        contentType = (
          kind === 'image' || kind === 'audio' || kind === 'video'
            ? kind
            : 'document'
        ) as NormalizedInbound['contentType'];
        // NOTE: do NOT expose `url` here. WAHA's media URL points at WAHA's
        // OWN internal host (e.g. http://localhost:3000/api/files/…) and needs
        // the host rewritten to baseUrl + an X-Api-Key header to fetch — both
        // of which live in fetchInboundMedia. Leaving `url` set would make the
        // generic pipeline fetch the raw internal URL directly (→ 404), so we
        // pass ONLY fetchKey to force the fetchInboundMedia path.
        media = {
          kind,
          mimetype,
          filename: p.media?.filename,
          fetchKey: { mediaUrl: p.media?.url },
          viewOnce,
        };
      }

      messages.push({
        externalMessageId,
        fromPhoneE164,
        fromMe,
        pushName,
        contentType,
        contentText: text || null,
        media,
        viewOnce,
      });
    }

    return { messages, statuses };
  },

  async fetchInboundMedia(
    ch: ChannelCtx,
    fetchKey: unknown,
  ): Promise<{ base64: string; mimetype: string } | null> {
    const key = fetchKey as { mediaUrl?: unknown } | null;
    let url = key && typeof key.mediaUrl === 'string' ? key.mediaUrl : '';
    if (!url) return null;
    // WAHA returns the media URL with an INTERNAL host (e.g.
    // http://localhost:3000/...) which we can't reach — rewrite the scheme
    // + host to the public baseUrl. Download with the X-Api-Key header
    // (per-channel), else WAHA's /api/files/ replies 401.
    url = url.replace(/^https?:\/\/[^/]+/i, baseUrlOf(ch));
    try {
      const res = await fetch(url, {
        headers: { 'X-Api-Key': apiKeyOf(ch) },
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        base64: buf.toString('base64'),
        mimetype: res.headers.get('content-type') || 'application/octet-stream',
      };
    } catch (err) {
      console.error(
        `[waha] fetchInboundMedia failed for ${url}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },

  async fetchProfilePicture(
    ch: ChannelCtx,
    phoneE164: string,
  ): Promise<{ url: string } | null> {
    // Build the WhatsApp contact id from E.164 digits. We do NOT run the
    // 9th-digit check-exists round-trip here (that's for SENDING) — the
    // profile-picture lookup is best-effort backfill, so a plain @c.us id
    // is fine; a miss just yields no photo.
    const digits = normalizePhone(phoneE164);
    if (!digits) return null;
    const chatId = `${digits}@c.us`;
    const base = baseUrlOf(ch);
    const session = sessionOf(ch);
    try {
      // VERIFIED against the live WAHA (NOWEB) instance:
      //   GET {base}/api/contacts/profile-picture?contactId=<id>&session=<s>
      //   → { profilePictureURL: "https://pps.whatsapp.net/..." } | { profilePictureURL: null }
      // The session-in-path variant (/api/{session}/contacts/...) 400s on
      // this engine, so we only use the query-param shape.
      const { ok, body } = await httpJson(
        `${base}/api/contacts/profile-picture?contactId=${encodeURIComponent(
          chatId,
        )}&session=${encodeURIComponent(session)}`,
        { method: 'GET', headers: headersOf(ch) },
      );
      if (!ok) return null;
      const url = (body as { profilePictureURL?: unknown }).profilePictureURL;
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        return { url };
      }
      return null;
    } catch (err) {
      console.error(
        `[waha] fetchProfilePicture failed for ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },

  // ---- session lifecycle (QR pairing) ----

  async startSession(
    ch: ChannelCtx,
    webhookUrl: string,
  ): Promise<{ qr?: string }> {
    const base = baseUrlOf(ch);
    const session = sessionOf(ch);
    const enc = encodeURIComponent(session);
    const config = {
      webhooks: [
        {
          url: webhookUrl,
          events: ['message', 'message.any', 'message.ack', 'session.status'],
        },
      ],
    };

    // ensureSession: create-or-update with the webhook config, ensure running.
    const cur = await httpJson(`${base}/api/sessions/${enc}`, {
      method: 'GET',
      headers: headersOf(ch),
    });
    // Whether we (re)started the session fresh below. A fresh start already
    // applies the webhook config, so we skip the running-session restart.
    let startedFresh = false;
    if (cur.ok) {
      // Already exists → refresh the webhook config first.
      await httpJson(`${base}/api/sessions/${enc}`, {
        method: 'PUT',
        headers: headersOf(ch),
        body: JSON.stringify({ config }),
      });
      const status = String((cur.body as { status?: unknown }).status || '');
      if (status === 'FAILED') {
        // The number was logged out (e.g. unlinked from WhatsApp on the
        // phone, or the same number paired elsewhere) → the stored auth is
        // dead. A plain restart won't recover a FAILED NOWEB session; we
        // must LOGOUT to clear the dead credentials, then start fresh so a
        // new QR is generated.
        await httpJson(`${base}/api/sessions/${enc}/logout`, {
          method: 'POST',
          headers: headersOf(ch),
          body: '{}',
        });
        await httpJson(`${base}/api/sessions/${enc}/start`, {
          method: 'POST',
          headers: headersOf(ch),
          body: '{}',
        });
        startedFresh = true;
      } else if (status === 'STOPPED') {
        await httpJson(`${base}/api/sessions/${enc}/start`, {
          method: 'POST',
          headers: headersOf(ch),
          body: '{}',
        });
        startedFresh = true;
      }
    } else {
      // Doesn't exist → create it, already started, with the webhook config.
      await httpJson(`${base}/api/sessions`, {
        method: 'POST',
        headers: headersOf(ch),
        body: JSON.stringify({ name: session, start: true, config }),
      });
      startedFresh = true;
    }

    // CRITICAL: a webhook config change on an ALREADY-RUNNING session only
    // takes effect after a restart — otherwise inbound / acks never arrive.
    // When we just started fresh (create / start), the config is already
    // applied, so skip the restart to avoid churning the pairing state.
    if (!startedFresh) {
      try {
        await httpJson(`${base}/api/sessions/${enc}/restart`, {
          method: 'POST',
          headers: headersOf(ch),
          body: '{}',
        });
      } catch {
        /* proceed even if the restart call fails */
      }
    }

    // Poll for the QR: NOWEB takes a few seconds to reach SCAN_QR_CODE.
    // If it's already WORKING, there's nothing to pair — return {}.
    for (let i = 0; i < 14; i++) {
      const s = await httpJson(`${base}/api/sessions/${enc}`, {
        method: 'GET',
        headers: headersOf(ch),
      });
      const status = String((s.body as { status?: unknown }).status || '');
      if (status === 'WORKING') return {};
      if (status === 'SCAN_QR_CODE') {
        try {
          const res = await fetch(`${base}/api/${enc}/auth/qr`, {
            headers: { 'X-Api-Key': apiKeyOf(ch) },
          });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            return { qr: `data:image/png;base64,${buf.toString('base64')}` };
          }
        } catch {
          /* retry on the next cycle */
        }
      }
      if (status === 'STOPPED' || status === 'FAILED') {
        await httpJson(`${base}/api/sessions/${enc}/start`, {
          method: 'POST',
          headers: headersOf(ch),
          body: '{}',
        });
      }
      await sleep(1500);
    }
    // Still initializing — no QR this round.
    return {};
  },

  async getState(
    ch: ChannelCtx,
  ): Promise<{ status: string; phoneNumber?: string | null }> {
    const { ok, body } = await httpJson(
      `${baseUrlOf(ch)}/api/sessions/${encodeURIComponent(sessionOf(ch))}`,
      { method: 'GET', headers: headersOf(ch) },
    );
    if (!ok) return { status: 'error' };
    const st = String((body as { status?: unknown }).status || '');
    // The paired number lives in `me.id` (e.g. "556791875477@c.us"). Surface
    // it so the channel row can persist phone_number once WORKING.
    const meId = (body as { me?: { id?: unknown } }).me?.id;
    const phoneNumber =
      typeof meId === 'string' && meId
        ? normalizePhone(meId.split('@')[0])
        : undefined;
    switch (st) {
      case 'WORKING':
        return { status: 'connected', phoneNumber };
      case 'SCAN_QR_CODE':
        return { status: 'qr_pending' };
      case 'STOPPED':
        return { status: 'disconnected' };
      case 'FAILED':
        return { status: 'error' };
      default:
        return { status: st ? st.toLowerCase() : 'disconnected' };
    }
  },
};

// ------------------------------------------------------------
// media base64 resolution (outbound)
// ------------------------------------------------------------

/**
 * WAHA sends media as raw base64. Prefer an inline base64 payload; else
 * fetch the (MinIO) public URL and encode it. Returns null when neither is
 * available or the fetch fails.
 */
async function resolveMediaBase64(media: OutboundMedia): Promise<string | null> {
  if (media.base64) return rawBase64(media.base64);
  if (media.url) {
    try {
      const res = await fetch(media.url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    } catch {
      return null;
    }
  }
  return null;
}

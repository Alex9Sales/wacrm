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
import {
  groupJidDigits,
  isGroupJid,
  mentionUsers,
  parseGroupParticipants,
} from '@/lib/whatsapp/group';

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

/** Cache of resolved @lid → phone (per session). The LID↔PN map is stable, and
 *  a bare-@lid inbound can repeat in a burst, so memoize with a TTL (null =
 *  "known-unresolvable", also cached, so we don't re-hit WAHA every message). */
const LID_PHONE_TTL_MS = 60 * 60_000;
const lidPhoneCache = new Map<string, { phone: string | null; exp: number }>();

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

/**
 * Best-effort profile-picture lookup for ANY WhatsApp chat id — a 1:1 contact
 * (`<digits>@c.us`) or a group (`<digits>@g.us`). Both go through the SAME
 * gows endpoint; only the id suffix differs, so the two public methods below
 * just build the id and delegate here.
 *
 * VERIFIED against the live WAHA/gows instance:
 *   GET {base}/api/contacts/profile-picture?contactId=<id>&session=<s>
 *   → { profilePictureURL: "https://pps.whatsapp.net/..." } | { profilePictureURL: null }
 * The session-in-path variant (/api/{session}/contacts/...) 400s on this
 * engine, so we only use the query-param shape.
 */
async function fetchPictureByChatId(
  ch: ChannelCtx,
  chatId: string,
): Promise<{ url: string } | null> {
  const base = baseUrlOf(ch);
  const session = sessionOf(ch);
  try {
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
      `[waha] fetchPictureByChatId failed for ${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
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

/**
 * WAHA/gows message id → the stable message HASH (the dedup key).
 *   1:1:   `<fromMe>_<chatJid>_<HASH>`
 *   group: `<fromMe>_<chatJid>_<HASH>_<participantJid>`  ← extra trailing jid
 * jids never contain `_`, so the HASH is always segment [2] when the id has the
 * full `<bool>_<jid>_<hash>` shape. The old `.pop()` took the LAST segment,
 * which for a GROUP id is the participant jid — constant per author — so every
 * message from one author collapsed to the same id and got dropped by the
 * inbound dedup after their first. Take [2]; plain/short ids pass through.
 */
function normalizeSerializedId(id: string): string {
  const parts = id.split('_');
  if (parts.length >= 3) return parts[2];
  return parts.pop() || id;
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
  // Already a full group jid (`…@g.us`, possibly with the legacy `<creator>-<ts>`
  // hyphen) — use it verbatim. Normalizing would strip the hyphen and break the
  // id, and check-exists is for 1:1 phones only.
  if (/@g\.us$/i.test(toE164)) return toE164;
  const digits = normalizePhone(toE164);
  // A GROUP target passed as bare digits (16+) — best-effort `<digits>@g.us`.
  // (Legacy hyphen jids should arrive already suffixed via the line above; this
  // covers the modern `120363…` ids whose digits ARE the jid.)
  if (isGroupJid(digits)) return `${digits}@g.us`;
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
  // Group messages carry the participant (author) jid outside the chat:
  //   NOWEB/Baileys: top-level `participant` / `author`, or `key.participant`.
  participant?: string;
  author?: string;
  _data?: {
    // WAHA NOWEB flags view-once here: `_data.key.isViewOnce` (confirmed
    // against a real payload — the media itself is withheld).
    // In a group, the sender participant is `key.participant`.
    key?: { remoteJidAlt?: string; isViewOnce?: boolean; participant?: string };
    // GOWS (whatsmeow) engine — waha-voip: raw Go Info struct. With native
    // @lid addressing the real phone lives in Info.SenderAlt (inbound) /
    // Info.RecipientAlt (fromMe echoes), both @s.whatsapp.net (confirmed
    // against a real waha-voip payload). In a GROUP, Info.Chat is the group
    // jid and Info.Sender is the participant who sent the message.
    Info?: {
      Chat?: string;
      Sender?: string;
      SenderAlt?: string;
      RecipientAlt?: string;
      IsGroup?: boolean;
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
/** Location share → a clickable Google Maps link (opens the pin, and the
 *  agent can forward it by copying the link). Handles static and live
 *  location, both engines (`_data.message` NOWEB / `_data.Message` GOWS). */
function textFromLocation(p: WahaMessagePayload): string {
  const msg = (p._data?.message ?? p._data?.Message) as
    | {
        locationMessage?: LocationNode
        liveLocationMessage?: LocationNode
      }
    | undefined
  const live = msg?.liveLocationMessage
  const loc = msg?.locationMessage ?? live
  const lat = loc?.degreesLatitude
  const lng = loc?.degreesLongitude
  if (typeof lat !== 'number' || typeof lng !== 'number') return ''
  const label = live ? '📍 Localização em tempo real' : '📍 Localização'
  const place = loc?.name || loc?.address
  const named = place ? `\n${place}` : ''
  return `${label}${named}\nhttps://www.google.com/maps?q=${lat},${lng}`
}

interface LocationNode {
  degreesLatitude?: number
  degreesLongitude?: number
  name?: string
  address?: string
}

/** Read a field trying multiple casings — GOWS PascalCases nested proto structs
 *  while NOWEB/Baileys keeps camelCase. */
function pickField(obj: unknown, ...names: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined
  const rec = obj as Record<string, unknown>
  for (const n of names) if (rec[n] != null) return rec[n]
  return undefined
}

function phoneFromVcard(v: string): string {
  const tel = v.match(/TEL[^:\n]*:\s*([+\d][\d\s()\-]{5,})/i)
  if (tel) return tel[1].trim().replace(/\s+/g, ' ')
  const waid = v.match(/waid=(\d{6,})/i)
  return waid ? `+${waid[1]}` : ''
}

/** Shared contact (vCard) message → legible line. Handles a single
 *  contactMessage and a contactsArrayMessage, both engine casings. */
function textFromContact(p: WahaMessagePayload): string {
  const m = (p._data?.message ?? p._data?.Message) as unknown
  const cards: unknown[] = []
  const single = pickField(m, 'contactMessage', 'ContactMessage')
  if (single) cards.push(single)
  const arr = pickField(m, 'contactsArrayMessage', 'ContactsArrayMessage')
  const list = pickField(arr, 'contacts', 'Contacts')
  if (Array.isArray(list)) cards.push(...list)
  const parts = cards
    .map((c) => {
      const name = String(pickField(c, 'displayName', 'DisplayName') ?? '')
      const vc = String(pickField(c, 'vcard', 'vCard', 'Vcard', 'VCard') ?? '')
      const phone = phoneFromVcard(vc)
      return [name, phone].filter(Boolean).join(' · ')
    })
    .filter(Boolean)
  return parts.length ? `👤 Contato: ${parts.join(' | ')}` : ''
}

/** Template / buttons / list messages (e.g. a WhatsApp/Meta marketing template
 *  someone forwards) → the body text, so it renders instead of an empty [text]. */
function textFromTemplate(p: WahaMessagePayload): string {
  const m = (p._data?.message ?? p._data?.Message) as unknown
  const bm = pickField(m, 'buttonsMessage', 'ButtonsMessage')
  if (bm) {
    const t = pickField(bm, 'contentText', 'ContentText', 'headerText', 'HeaderText')
    if (t) return String(t)
  }
  const lm = pickField(m, 'listMessage', 'ListMessage')
  if (lm) {
    const t = pickField(lm, 'description', 'Description', 'title', 'Title')
    if (t) return String(t)
  }
  const tm = pickField(m, 'templateMessage', 'TemplateMessage')
  if (tm) {
    const h =
      pickField(
        tm,
        'hydratedTemplate',
        'HydratedTemplate',
        'hydratedFourRowTemplate',
        'HydratedFourRowTemplate',
      ) ?? tm
    const t = pickField(
      h,
      'hydratedContentText',
      'HydratedContentText',
      'hydratedTitleText',
      'HydratedTitleText',
    )
    if (t) return String(t)
  }
  return ''
}

/** Marker + separators the button line is encoded with (parsed by the inbox
 *  bubble). A URL/CTA button carries its link after BTN_URL_SEP so the bubble
 *  can open it instead of sending a text reply. */
const BTN_PREFIX = '🔘 Botões: ';
const BTN_SEP = ' · ';
const BTN_URL_SEP = ' ↗ ';

interface TemplateButton {
  label: string;
  /** Set only for a URL/CTA button — the bubble opens it (vs a quick-reply,
   *  which sends the label as a text reply). */
  url?: string;
}

/** The carriers a button can live in. `interactiveMessage` included because
 *  Meta CTA buttons ("Acessar a aula") ride there as a nativeFlow. */
function buttonCarrier(p: WahaMessagePayload): unknown {
  const m = p._data?.message ?? p._data?.Message;
  return pickField(
    m,
    'templateMessage',
    'TemplateMessage',
    'buttonsMessage',
    'ButtonsMessage',
    'listMessage',
    'ListMessage',
    'interactiveMessage',
    'InteractiveMessage',
  );
}

/** Collect the buttons of a template / buttons / list / interactive message —
 *  a Meta template's "Confirmar" / "Remarcar" quick-replies OR a URL/CTA button
 *  like "Link da aula" / "Acessar a aula". Two shapes in the wild:
 *   - hydrated / classic: the label is a direct `displayText`, a URL button
 *     carrying a sibling `url`;
 *   - nativeFlow CTA: label + url live INSIDE a `buttonParamsJson` string
 *     (`{"display_text":"Acessar a aula","url":"https://…"}`) — same shape the
 *     Pix card parses, so we skip payment flows here (handled by
 *     textFromInteractive). A URL keeps its link (the CRM opens it); a
 *     quick-reply has none (the CRM sends the label as a reply). Order-preserving
 *     + deduped by label. */
function templateButtons(p: WahaMessagePayload): TemplateButton[] {
  const carrier = buttonCarrier(p);
  if (!carrier) return [];
  const out: TemplateButton[] = [];
  const seen = new Set<string>();
  const add = (label: unknown, url: unknown): void => {
    if (typeof label !== 'string' || !label.trim() || seen.has(label.trim())) {
      return;
    }
    const l = label.trim();
    seen.add(l);
    const u =
      typeof url === 'string' && /^https?:\/\//i.test(url.trim())
        ? url.trim()
        : undefined;
    out.push({ label: l, url: u });
  };
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    // nativeFlow CTA: label + url are inside a JSON string.
    const rawParams = pickField(rec, 'buttonParamsJson', 'buttonParamsJSON');
    if (typeof rawParams === 'string') {
      try {
        const params = JSON.parse(rawParams) as Record<string, unknown>;
        // Pix / payment flows render as their own card, not a button.
        if (!('payment_settings' in params) && !('pix_static_code' in params)) {
          add(params.display_text ?? params.displayText, params.url);
        }
      } catch {
        // malformed JSON — ignore this button
      }
    }
    // hydrated / classic: label is a direct field, URL a sibling.
    add(
      pickField(rec, 'displayText', 'DisplayText', 'display_text'),
      pickField(rec, 'url', 'URL', 'Url'),
    );
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(carrier, 0);
  return out;
}

/** Last-resort text for an unrecognized STRUCTURED message — a template /
 *  button / flow / list variant we don't have a specific parser for (Meta keeps
 *  shipping new proto shapes). Walk the raw message node (bounded depth) and
 *  return the first legible text field, preferring body/content over titles, so
 *  the bubble shows the actual copy instead of a bare [text]. Only meant as the
 *  final fallback after every specific extractor came up empty AND the message
 *  carries no media (callers also gate out reactions/albums, which legitimately
 *  have no renderable body and must stay dropped). */
const DEEP_TEXT_KEYS = [
  'hydratedcontenttext',
  'contenttext',
  'conversation',
  'selecteddisplaytext',
  'caption',
  'description',
  'text',
  'hydratedtitletext',
  'title',
  'displaytext',
];
function textFromStructuredDeep(p: WahaMessagePayload): string {
  const root = (p._data?.message ?? p._data?.Message) as unknown;
  if (!root || typeof root !== 'object') return '';
  const found = new Map<string, string>();
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const el of node) visit(el, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string') {
        const kl = k.toLowerCase();
        const val = v.trim();
        if (val && !found.has(kl)) found.set(kl, val);
      } else if (v && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };
  visit(root, 0);
  for (const key of DEEP_TEXT_KEYS) {
    const hit = found.get(key);
    if (hit) return hit;
  }
  return '';
}

function detectViewOnce(p: WahaMessagePayload): boolean {
  return (
    p._data?.key?.isViewOnce === true ||
    p.viewOnce === true ||
    p._data?.viewOnce === true ||
    p._data?.IsViewOnce === true // GOWS (waha-voip)
  );
}

/** True when the message node is ONLY a reaction — `reactionMessage` (plain)
 *  or `encReactionMessage` (encrypted, GOWS/whatsmeow). These carry no body,
 *  so we drop them rather than store an empty placeholder row. */
function isReactionMessage(p: WahaMessagePayload): boolean {
  const m = (p._data?.message ?? p._data?.Message) as
    | Record<string, unknown>
    | undefined;
  if (!m) return false;
  return 'reactionMessage' in m || 'encReactionMessage' in m;
}

/** True when the node is a WhatsApp "album" header — the grouping placeholder
 *  that only announces N images/M videos (`albumMessage`, GOWS `AlbumMessage`).
 *  The actual photos/videos arrive as their OWN subsequent messages, so this
 *  header carries no body/media and must be dropped rather than stored as an
 *  empty [text] row sitting as noise right before the media it announces. */
function isAlbumMessage(p: WahaMessagePayload): boolean {
  const m = (p._data?.message ?? p._data?.Message) as
    | Record<string, unknown>
    | undefined;
  if (!m) return false;
  return 'albumMessage' in m || 'AlbumMessage' in m;
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

/**
 * Build the `group` descriptor for an inbound GROUP message. The chat jid is
 * the group; the AUTHOR (participant) lives elsewhere depending on the engine:
 *   - GOWS/whatsmeow (waha-voip): `_data.Info.Sender`
 *   - NOWEB/Baileys: top-level `participant` / `author`, or `key.participant`
 * Author phone/name are best-effort (used only to label the line — the group
 * thread itself is keyed by the group jid, not the author).
 */
function buildGroupInfo(
  p: WahaMessagePayload,
  chatJid: string,
): NonNullable<NormalizedInbound['group']> {
  const info = p._data?.Info;
  const senderJid = String(
    info?.Sender ||
      p.participant ||
      p.author ||
      p._data?.key?.participant ||
      '',
  );
  const isLid = LID_RE.test(senderJid);
  // In a @lid group the sender jid is the LID (not the phone) — the real phone
  // rides in Info.SenderAlt (@s.whatsapp.net). Capture both: the LID user-part
  // (mention token) and the phone (contact key), both mapped to the pushName.
  const authorLid = isLid
    ? senderJid.split('@')[0].split(':')[0].replace(/\D/g, '')
    : '';
  const phoneJid = String(info?.SenderAlt || (isLid ? '' : senderJid));
  const authorPhone = phoneJid
    ? normalizePhone(phoneJid.split('@')[0].split(':')[0])
    : '';
  const authorName = String(
    info?.PushName ||
      p._data?.pushName ||
      p.notifyName ||
      p._data?.notifyName ||
      '',
  );
  const mentions = mentionUsers(extractMentionedJids(p));
  return {
    jid: chatJid,
    authorName: authorName || undefined,
    authorPhone: authorPhone || undefined,
    authorLid: authorLid || undefined,
    mentions: mentions.length ? mentions : undefined,
  };
}

/** Pull the mentioned-jid list out of a message node — WhatsApp puts it in
 *  `<type>.contextInfo.mentionedJID` (gows) / `mentionedJid` (NOWEB). Scans the
 *  message node's children so it works regardless of message type. */
function extractMentionedJids(p: WahaMessagePayload): string[] {
  const node = (p._data?.message ?? p._data?.Message) as
    | Record<string, unknown>
    | undefined;
  if (!node) return [];
  for (const v of Object.values(node)) {
    if (!v || typeof v !== 'object') continue;
    const ci = (v as Record<string, unknown>).contextInfo ??
      (v as Record<string, unknown>).ContextInfo;
    if (ci && typeof ci === 'object') {
      const list =
        (ci as Record<string, unknown>).mentionedJID ??
        (ci as Record<string, unknown>).mentionedJid ??
        (ci as Record<string, unknown>).MentionedJID;
      if (Array.isArray(list)) return list.map(String);
    }
  }
  return [];
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

  /** Edit an own message's text. WAHA/gows:
   *  PUT /api/{session}/chats/{chatId}/messages/{messageId} { text }.
   *  gows keys messages by the SERIALIZED id (`true_<chatId>_<HASH>`) while we
   *  store just the HASH — reconstruct it (fromMe=true, since only our own
   *  messages are editable). Throws on failure so the caller can leave the CRM
   *  copy untouched (no silent desync). */
  async editMessage(
    ch: ChannelCtx,
    toE164: string,
    targetExternalId: string,
    newText: string,
  ): Promise<void> {
    const chatId = await resolveChatId(ch, toE164);
    // Reconstruct the serialized id unless the caller already passed one.
    const serialized = targetExternalId.includes('_')
      ? targetExternalId
      : `true_${chatId}_${targetExternalId}`;
    const url = `${baseUrlOf(ch)}/api/${sessionOf(ch)}/chats/${encodeURIComponent(
      chatId,
    )}/messages/${encodeURIComponent(serialized)}`;
    const { ok, status, body } = await httpJson(url, {
      method: 'PUT',
      headers: headersOf(ch),
      body: JSON.stringify({ text: newText, session: sessionOf(ch) }),
    });
    if (!ok) {
      throw new Error(`waha editMessage failed: ${wahaError(body, status)}`);
    }
  },

  // sendTemplate / sendInteractive intentionally omitted:
  // capabilities.templates and capabilities.interactive are both false.

  /** List the WhatsApp groups this channel's number belongs to (for the
   *  opt-in monitoring picker). gows: GET /api/{session}/groups → [{JID,Name,
   *  LinkedParentJID,...}]. A group inside a WhatsApp Community carries
   *  `LinkedParentJID` pointing at the community node — we resolve its name so
   *  the picker can show/search by community (a sub-group like "Conversa
   *  Business" is otherwise undiscoverable by the community name). */
  async listGroups(
    ch: ChannelCtx,
  ): Promise<{ jid: string; name: string; community?: string }[]> {
    const { ok, body } = await httpJson(
      `${baseUrlOf(ch)}/api/${sessionOf(ch)}/groups`,
      { method: 'GET', headers: headersOf(ch) },
    );
    if (!ok || !Array.isArray(body)) return [];
    const raw = body as Array<{
      JID?: string;
      jid?: string;
      Name?: string;
      name?: string;
      LinkedParentJID?: string;
    }>;
    // jid → name, so we can resolve a sub-group's community by its parent jid.
    const nameByJid = new Map<string, string>();
    for (const g of raw) {
      const jid = String(g.JID ?? g.jid ?? '');
      if (jid) nameByJid.set(jid, String(g.Name ?? g.name ?? ''));
    }
    return raw
      .map((g) => {
        const parent = String(g.LinkedParentJID ?? '');
        const community = parent ? nameByJid.get(parent) : undefined;
        return {
          jid: String(g.JID ?? g.jid ?? ''),
          name: String(g.Name ?? g.name ?? ''),
          community: community || undefined,
        };
      })
      .filter((g) => g.jid);
  },

  /** Resolve a group's participants to (LID user-part, phone digits) pairs. The
   *  participant list rides on the same gows endpoint as listGroups —
   *  GET /api/{session}/groups → [{ JID, Participants:[{ JID:'…@lid',
   *  PhoneNumber:'…@s.whatsapp.net', … }] }] — so we fetch it, pick the group by
   *  jid digits (robust to the @g.us-vs-bare mismatch), and reduce Participants
   *  to the two ids the mention contact-fallback keys on. */
  async listGroupParticipants(
    ch: ChannelCtx,
    groupJid: string,
  ): Promise<{ lidUser?: string; phone?: string }[]> {
    const { ok, body } = await httpJson(
      `${baseUrlOf(ch)}/api/${sessionOf(ch)}/groups`,
      { method: 'GET', headers: headersOf(ch) },
    );
    if (!ok || !Array.isArray(body)) return [];
    const wanted = groupJidDigits(groupJid);
    if (!wanted) return [];
    const group = (body as Array<Record<string, unknown>>).find((g) => {
      const jid = String(g.JID ?? g.jid ?? '');
      return jid !== '' && groupJidDigits(jid) === wanted;
    });
    if (!group) return [];
    return parseGroupParticipants(group.Participants ?? group.participants);
  },

  /** Resolve a @lid privacy id to the contact's real phone. gows/WAHA keeps a
   *  LID↔PN map: GET /api/{session}/lids/{lid} → { lid, pn:"55…@c.us" }. Used for
   *  a 1:1 inbound that arrived addressed ONLY by @lid (no phone in the payload).
   *  Cached per session (TTL); null when the lid is unknown. */
  async resolveLidToPhone(
    ch: ChannelCtx,
    lid: string,
  ): Promise<string | null> {
    const user = lid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (!user) return null;
    const cacheKey = `${sessionOf(ch)}:${user}`;
    const now = Date.now();
    const hit = lidPhoneCache.get(cacheKey);
    if (hit && hit.exp > now) return hit.phone;
    let phone: string | null = null;
    try {
      const { ok, body } = await httpJson(
        `${baseUrlOf(ch)}/api/${sessionOf(ch)}/lids/${encodeURIComponent(user)}`,
        { method: 'GET', headers: headersOf(ch) },
      );
      const pn = (body as { pn?: unknown })?.pn;
      if (ok && typeof pn === 'string' && !LID_RE.test(pn)) {
        const digits = normalizePhone(pn.split('@')[0].split(':')[0]);
        if (digits) phone = digits;
      }
    } catch (err) {
      console.error(
        `[waha] resolveLidToPhone failed for ${user}:`,
        err instanceof Error ? err.message : err,
      );
      return null; // transient — don't cache a failure
    }
    lidPhoneCache.set(cacheKey, { phone, exp: now + LID_PHONE_TTL_MS });
    return phone;
  },

  async sendLocation(
    ch: ChannelCtx,
    toE164: string,
    loc: { latitude: number; longitude: number; title?: string },
  ): Promise<{ externalMessageId: string }> {
    const chatId = await resolveChatId(ch, toE164);
    const { ok, status, body } = await sendWithRetry(ch, 'sendLocation', {
      session: sessionOf(ch),
      chatId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      title: loc.title,
    });
    if (!ok) {
      throw new Error(`waha sendLocation failed: ${wahaError(body, status)}`);
    }
    const externalMessageId = extractExternalId(body as Record<string, unknown>);
    if (!externalMessageId) {
      throw new Error('waha sendLocation: response carried no message id');
    }
    return { externalMessageId };
  },

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
      // GROUP message → ingest as a group thread (the pipeline drops it unless
      // the group is opt-in monitored). Newsletters / broadcast / status / a
      // bare @lid without an alt stay dropped as before.
      const group = isGroupJid(chat) ? buildGroupInfo(p, chat) : null;
      // A bare @lid 1:1 (no @s.whatsapp.net alt) hides the phone — WhatsApp sent
      // ONLY the LID. Don't drop it: capture the LID so the async webhook route
      // resolves it to the real phone (via resolveLidToPhone) and ingests it in
      // the right contact thread. Empty chat + non-direct jids (group/newsletter/
      // broadcast/status) still drop as before.
      const senderLid =
        !group && !isNonDirectJid(chat) && LID_RE.test(chat)
          ? chat.split('@')[0].split(':')[0].replace(/\D/g, '')
          : '';
      if (!group && !senderLid && (!chat || isNonDirectJid(chat) || LID_RE.test(chat))) {
        return { messages, statuses };
      }

      let text = textOfPayload(p);
      // WhatsApp Pix key cards arrive as an interactiveMessage with no body —
      // extract the key so it renders instead of an empty [text].
      if (!text) text = textFromInteractive(p);
      // Shared contact (vCard) → name · phone.
      if (!text) text = textFromContact(p);
      // Template / buttons / list (e.g. a forwarded marketing template) → body.
      if (!text) text = textFromTemplate(p);
      // Last resort for an unrecognized structured message (a template variant
      // we don't specifically parse yet): deep-scan the node for any legible
      // text so it renders instead of a bare [text]. Gated out of media and of
      // reactions/albums (those have no body and must stay dropped below).
      if (
        !text &&
        !p.hasMedia &&
        !p.media &&
        !isReactionMessage(p) &&
        !isAlbumMessage(p)
      ) {
        text = textFromStructuredDeep(p);
      }
      // A template's buttons: quick-replies ("Confirmar"/"Remarcar") the agent
      // fires as a reply, or URL/CTA buttons ("Link da aula") the CRM opens.
      // Encode them on a trailing marker line the inbox bubble turns into chips
      // (label alone = quick-reply; "label ↗ url" = link).
      const btns = templateButtons(p);
      if (btns.length) {
        const parts = btns.map((b) =>
          b.url ? `${b.label}${BTN_URL_SEP}${b.url}` : b.label,
        );
        text = `${text ? `${text}\n\n` : ''}${BTN_PREFIX}${parts.join(BTN_SEP)}`;
      } else {
        // Diagnostic: a message whose carrier looks like it HAS buttons but we
        // extracted none — log the shape so we can add a parser for it.
        const carrier = buttonCarrier(p);
        const dump = carrier ? JSON.stringify(carrier) : '';
        if (
          /button|hydrated|nativeflow/i.test(dump) &&
          !/payment_settings|pix_static_code/i.test(dump)
        ) {
          console.log('[waha parse] BTNMISS sample=', dump.slice(0, 1400));
        }
      }
      // Location shares: render as a clickable Google Maps link (opens the
      // pin; forwardable by copying the link) instead of an empty [text].
      const locationText = textFromLocation(p);
      if (locationText) text = locationText;
      const raw = serializedIdToString(p.id);
      const externalMessageId = raw ? normalizeSerializedId(raw) : '';
      // GOWS alts carry the multi-device suffix ("556…5477:9@s.whatsapp.net");
      // strip it BEFORE normalizing or the digits gain a phantom tail and
      // spawn a duplicate contact + conversation.
      // For a group, `chat` is the group jid; attribute the message to the
      // author's phone (best-effort) — the group thread itself is resolved by
      // ev.group.jid in the pipeline, so this is only for completeness.
      // An unresolved @lid carries no phone — leave it empty; the route fills it
      // in via resolveLidToPhone(senderLid) before dispatch.
      const fromPhoneE164 = senderLid
        ? ''
        : group?.authorPhone ||
          normalizePhone(chat.split('@')[0].split(':')[0]);
      const pushName =
        p._data?.pushName ||
        p._data?.notifyName ||
        p.notifyName ||
        info?.PushName ||
        undefined;

      const viewOnce = detectViewOnce(p);
      let media: NormalizedInbound['media'] | undefined;
      let contentType: NormalizedInbound['contentType'] = 'text';
      // A location's JPEG thumbnail can look like media — keep it as the
      // text (maps link) rather than trying to fetch a nonexistent file.
      if ((p.hasMedia || p.media) && !locationText) {
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

      // A reaction (👍 etc — encrypted `encReactionMessage` or plain
      // `reactionMessage`) or an album header (`albumMessage` — the photos it
      // announces arrive as their own messages) comes in with no body/media.
      // Drop it: it must NOT become an empty "[text]" row — in a monitored group
      // it would spam the thread on every reaction / album.
      if (
        !text &&
        !media &&
        !viewOnce &&
        (isReactionMessage(p) || isAlbumMessage(p))
      ) {
        return { messages, statuses };
      }

      // Diagnostic: anything that would still render as a bare [text]/[type]
      // placeholder — log the raw proto keys so we can add a parser for it.
      if (!text && !media && !viewOnce) {
        const mm = (p._data?.Message ?? p._data?.message) as
          | Record<string, unknown>
          | undefined;
        console.log(
          '[waha parse] UNRENDERED type=',
          String((p as { type?: unknown }).type ?? ''),
          'keys=',
          mm ? Object.keys(mm).join(',') : 'none',
          'sample=',
          JSON.stringify(mm ?? {}).slice(0, 900),
        );
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
        group: group ?? undefined,
        senderLid: senderLid || undefined,
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
    return fetchPictureByChatId(ch, `${digits}@c.us`);
  },

  async fetchGroupPicture(
    ch: ChannelCtx,
    groupJid: string,
  ): Promise<{ url: string } | null> {
    // Groups share the 1:1 profile-picture endpoint — only the id suffix is
    // `@g.us` instead of `@c.us`. Pass the FULL group jid VERBATIM: old-format
    // group jids are `<creator>-<timestamp>@g.us` and the hyphen is
    // significant — stripping to bare digits (groupJidDigits) yields a jid the
    // engine can't resolve, so it returns null and no photo ever lands. We only
    // ensure the `@g.us` suffix and keep every other char. A genuine miss
    // (photo not yet propagated / no photo / privacy) still yields null and the
    // caller retries on a later message.
    const raw = (groupJid ?? '').trim();
    if (!/\d/.test(raw)) return null;
    const chatId = raw.includes('@') ? raw : `${raw}@g.us`;
    return fetchPictureByChatId(ch, chatId);
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
          // Includes the waha-voip native-call events so a freshly-connected
          // channel rings inbound calls in the CRM without any extra setup.
          // (Harmless on engines that don't emit them, e.g. NOWEB.)
          events: [
            'message',
            'message.any',
            'message.ack',
            'session.status',
            'call.received',
            'call.accepted',
            'call.rejected',
          ],
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

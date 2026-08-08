// ============================================================
// Provider interface — the seam every WhatsApp transport plugs into
// (Phase 4). Meta (official Cloud API), WAHA, Evolution, and EvoGo all
// implement `WhatsAppProvider`. The agnostic inbound pipeline
// (inbound.ts) and outbound sender (send-message.ts, wave 3) only ever
// talk to a provider through this interface — they never import a
// concrete adapter.
//
// The concrete adapters (meta.ts / waha.ts / evolution.ts / evogo.ts)
// land in wave 2; this file only defines the contract + capability
// table. See docs/fase4-multicanal.md for the design + provider
// cheat-sheet this mirrors.
// ============================================================

/** The set of transports we support. */
export type ProviderId = 'meta' | 'waha' | 'evolution' | 'evogo';

/**
 * What a given provider can and can't do. Drives capability checks
 * BEFORE we attempt an operation (e.g. reject a template send on a WAHA
 * channel with a clean 422 rather than a cryptic upstream error) and
 * how the inbound pipeline handles media.
 */
export interface Capabilities {
  /** Approved message templates — only Meta. */
  templates: boolean;
  /** The 24h customer-service window (template required outside it) — only Meta. */
  session24hWindow: boolean;
  /** Interactive button / list messages — only Meta. */
  interactive: boolean;
  /** Emoji reactions. */
  reactions: boolean;
  /** "digitando…" presence (start/stop typing). Non-official engines only. */
  typing: boolean;
  /** QR-code pairing to bind a session — the non-official providers. */
  qrPairing: boolean;
  /**
   * Whether inbound media is available at all. EvoGo does NOT deliver
   * base64 in the webhook and has no fetch API — inbound media is
   * structurally impossible there, so the pipeline stores a text
   * placeholder instead.
   */
  inboundMedia: boolean;
  /**
   * WAHA needs a check-exists round-trip to resolve the real chatId
   * (Brazilian 9th-digit ambiguity) before sending.
   */
  needsChatIdResolve: boolean;
  /** Non-official providers need send jitter to reduce ban risk. */
  needsJitter: boolean;
}

/**
 * A single inbound message normalized across every provider. The
 * provider's `parseWebhook` produces these; the agnostic pipeline
 * consumes them without knowing which transport they came from.
 */
export interface NormalizedInbound {
  /** The provider-side message id — used for dedup (→ messages.message_id). */
  externalMessageId: string;
  /** Sender phone in E.164 digits (55 + DDD + number), already normalized. */
  fromPhoneE164: string;
  /** True when this event echoes a message WE sent (fromMe). */
  fromMe: boolean;
  /** WhatsApp push name, when the provider supplies it. */
  pushName?: string;
  /**
   * Set when a 1:1 message arrived addressed ONLY by @lid, with no phone in the
   * payload (`fromPhoneE164` is then empty). The webhook route resolves it to
   * the real phone via `resolveLidToPhone` BEFORE dispatch, so the message lands
   * in the right contact thread instead of being lost. Carries the LID user-part
   * (digits only).
   */
  senderLid?: string;
  contentType:
    | 'text'
    | 'image'
    | 'audio'
    | 'video'
    | 'document'
    | 'location'
    | 'interactive';
  contentText?: string | null;
  /**
   * Inbound media. `base64` (inline) or `url` (downloadable) is set when
   * the provider delivered the bytes. `fetchKey` is an opaque handle the
   * provider's `fetchInboundMedia` can later resolve into bytes (WAHA /
   * Evolution) — the pipeline does NOT interpret it.
   */
  media?: {
    kind: string;
    mimetype?: string;
    base64?: string;
    url?: string;
    filename?: string;
    fetchKey?: unknown;
    /** WhatsApp "view once" media — the CRM persists it so agents can
     *  re-open, but the bubble hides it behind a tap-to-reveal cover. */
    viewOnce?: boolean;
  };
  /** For interactive button / list taps: the stable id of the option. */
  interactiveReplyId?: string;
  /** When the customer swipe-replied: the external id of the quoted message. */
  replyToExternalId?: string;
  /** WhatsApp "view once" — set even when the provider delivers no media
   *  (WAHA flags it but withholds the bytes). */
  viewOnce?: boolean;
  /**
   * Set ONLY for a message from a WhatsApp GROUP. Its mere presence routes the
   * message to the isolated group-ingestion path (opt-in filtered against
   * monitored_groups) instead of the 1:1 contact/conversation pipeline — a
   * group event must never touch the direct-message flow. `jid` is the group's
   * jid (`…@g.us` or bare) used for the opt-in lookup; `authorName`/
   * `authorPhone` identify the participant who sent it (best-effort).
   */
  group?: {
    jid: string;
    name?: string;
    authorName?: string;
    authorPhone?: string;
    /** The author's LID user-part (when the group uses @lid addressing). Used
     *  to register their pushName so later @mentions resolve to the name. */
    authorLid?: string;
    /** Mentioned participants' user-parts (LID user or phone digits) — the
     *  pipeline rewrites "@<user>" in the body to the known display name. */
    mentions?: string[];
  };
}

/** A delivery/read receipt normalized across providers. */
export interface NormalizedStatus {
  externalMessageId: string;
  /** 2 = delivered, 3 = read. (Lower levels aren't surfaced.) */
  level: 2 | 3;
}

/**
 * A decrypted channel row — what every provider method receives as its
 * first argument. `credentials` is the parsed JSON (already decrypted),
 * NOT the ciphertext. Built by loadChannel() in channels.ts.
 */
export interface ChannelCtx {
  id: string;
  accountId: string;
  provider: ProviderId;
  name: string;
  phoneNumber: string | null;
  /** Decrypted, parsed credentials JSON (provider-specific shape). */
  credentials: Record<string, unknown>;
  /** provider_meta: routing info (phone_number_id, baseUrl, session…). */
  providerMeta: Record<string, unknown>;
  /** settings: throughput / jitter tuning. */
  settings: Record<string, unknown>;
  webhookSecret: string;
}

/** Outbound send options shared across send* methods. */
export interface SendOptions {
  /** External id of a message to quote (swipe-reply). */
  contextExternalId?: string;
  /** Whether the quoted message was ours (agent/bot) vs the customer's. WAHA
   *  keys messages by a SERIALIZED id `<fromMe>_<chatId>_<HASH>` but we store
   *  only the HASH, so the adapter needs this to reconstruct `reply_to`. */
  contextFromMe?: boolean;
  /**
   * Group @mentions: the jids to ping (e.g. `["146…@lid"]`). The text must
   * already carry the matching `@<user>` tokens. Providers that support it send
   * a real WhatsApp mention (blue, notifies); others ignore it (plain text).
   */
  mentions?: string[];
}

/** Outbound media descriptor. */
export interface OutboundMedia {
  kind: 'image' | 'video' | 'document' | 'audio';
  /** Public URL (Meta sends by link) or a base64 payload (non-official). */
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
}

/** Outbound location pin. */
export interface OutboundLocation {
  latitude: number;
  longitude: number;
  /** Optional label shown on the pin (e.g. the business name/address). */
  title?: string;
}

/** Outbound template descriptor (Meta only). */
export interface OutboundTemplate {
  name: string;
  language: string;
  params?: unknown;
}

/** Outbound interactive descriptor (Meta only). */
export interface OutboundInteractive {
  [key: string]: unknown;
}

/**
 * A customer's emoji reaction to a message, normalized across providers.
 * `emoji === ''` means the reaction was REMOVED (unreact).
 */
export interface NormalizedReaction {
  /** External id of the reacted-to message (already normalized to our form). */
  targetExternalId: string;
  /** Reactor's phone in E.164 digits. */
  fromPhoneE164: string;
  /** True when WE reacted (echo of an agent reaction) — the route skips these. */
  fromMe: boolean;
  /** The emoji, or '' when the reaction was removed. */
  emoji: string;
}

/** A message DELETED on WhatsApp (revoke / "apagar para todos"). */
export interface NormalizedDeletion {
  /** External id of the deleted message (already normalized to our form). */
  targetExternalId: string;
}

/** A message EDITED on WhatsApp (cliente/usuário editou o texto). */
export interface NormalizedEdit {
  /** External id of the edited message (already normalized to our form). */
  targetExternalId: string;
  /** The NEW text after the edit. */
  newText: string;
}

/** The shape `parseWebhook` returns. */
export interface ParsedWebhook {
  messages: NormalizedInbound[];
  statuses: NormalizedStatus[];
  /** Customer reactions (non-official engines emit these as their own event). */
  reactions?: NormalizedReaction[];
  /** Messages deleted on WhatsApp. */
  deletions?: NormalizedDeletion[];
  /** Messages edited on WhatsApp (novo texto). */
  edits?: NormalizedEdit[];
}

/**
 * What `verifyWebhook` receives. Carries the RAW request body (not a
 * re-encoded JSON) plus the request headers, because Meta signs the exact
 * bytes it POSTed with HMAC-SHA256 — re-serializing the parsed JSON would
 * change the bytes and break the signature. The route reads the body once
 * (`await request.text()`) and passes it here so both verifyWebhook and
 * parseWebhook see identical bytes.
 *
 * `headers` is the WHATWG `Headers` so providers can read whatever header
 * they sign with (Meta: `x-hub-signature-256`; non-official: a per-channel
 * token header). Kept small and provider-agnostic so every adapter shares
 * one shape.
 */
export interface WebhookVerifyCtx {
  rawBody: string;
  headers: Headers;
}

/**
 * The provider contract. Required methods every transport implements;
 * optional methods are gated by `capabilities` (e.g. only Meta has
 * `sendTemplate`, only the QR providers have `startSession`).
 */
export interface WhatsAppProvider {
  readonly id: ProviderId;
  readonly capabilities: Capabilities;

  sendText(
    ch: ChannelCtx,
    toE164: string,
    text: string,
    opts?: SendOptions,
  ): Promise<{ externalMessageId: string }>;

  sendMedia(
    ch: ChannelCtx,
    toE164: string,
    media: OutboundMedia,
  ): Promise<{ externalMessageId: string }>;

  sendTemplate?(
    ch: ChannelCtx,
    toE164: string,
    tpl: OutboundTemplate,
  ): Promise<{ externalMessageId: string }>;

  sendInteractive?(
    ch: ChannelCtx,
    toE164: string,
    i: OutboundInteractive,
  ): Promise<{ externalMessageId: string }>;

  sendReaction?(
    ch: ChannelCtx,
    targetExternalId: string,
    emoji: string,
  ): Promise<void>;

  /**
   * Toggle the "digitando…" presence in a chat (`on` = start, false = stop).
   * Best-effort and non-critical: implementations swallow errors. Optional —
   * only the non-official engines expose presence (WAHA does; Meta does not).
   */
  sendTyping?(ch: ChannelCtx, toE164: string, on: boolean): Promise<void>;

  /**
   * Edit the text of a message WE previously sent (WhatsApp "Editar"). Optional
   * — only engines whose API exposes edit implement it (gows/WAHA). WhatsApp
   * only allows editing within ~15 min and only own messages; the caller
   * enforces that, and a late/invalid edit throws. `toE164` identifies the chat
   * (a group's jid digits resolve to `@g.us`), `targetExternalId` is the stored
   * message id.
   */
  editMessage?(
    ch: ChannelCtx,
    toE164: string,
    targetExternalId: string,
    newText: string,
  ): Promise<void>;

  /**
   * Delete a message WE previously sent, FOR EVERYONE ("apagar para todos" /
   * revoke). Optional — only engines whose API exposes revoke implement it
   * (WAHA/gows). WhatsApp only allows this within a time window and only for
   * own messages; the caller enforces that and a late/invalid revoke throws.
   */
  deleteMessage?(
    ch: ChannelCtx,
    toE164: string,
    targetExternalId: string,
  ): Promise<void>;

  /** Send a location pin (map card). Optional — only providers whose engine
   *  exposes it implement it (waha-voip/gows does; Meta does not here). */
  sendLocation?(
    ch: ChannelCtx,
    toE164: string,
    loc: OutboundLocation,
  ): Promise<{ externalMessageId: string }>;

  /** List the WhatsApp groups this channel's number belongs to. Optional —
   *  only the non-official engines expose it. For group-monitoring opt-in.
   *  `community` is the parent Community's name when the group is a sub-group
   *  (lets the picker show/search by community). */
  listGroups?(
    ch: ChannelCtx,
  ): Promise<{ jid: string; name: string; community?: string }[]>;

  /**
   * Resolve a group's participants to (LID user-part, phone digits) pairs, so
   * the inbound pipeline can map a `@lid` mention to a saved contact when the
   * mentioned person never posted (and thus has no registry name). Optional —
   * only the non-official engines that expose the participant list implement it
   * (gows/WAHA does; Meta does not). Best-effort: returns `[]` on any failure.
   */
  listGroupParticipants?(
    ch: ChannelCtx,
    groupJid: string,
  ): Promise<{ lidUser?: string; phone?: string }[]>;

  /**
   * Resolve a `@lid` privacy id to the contact's real phone (E.164 digits). Used
   * by the webhook route when a 1:1 message arrives addressed only by @lid, with
   * no phone in the payload — WhatsApp's LID addressing. Optional: only the
   * engines exposing a LID→PN map implement it (gows/WAHA does). Returns null
   * when the id can't be resolved (unknown lid / error).
   */
  resolveLidToPhone?(ch: ChannelCtx, lid: string): Promise<string | null>;

  /**
   * Meta: HMAC over the raw body via the global app secret. Others: match
   * the per-channel webhook_secret against a header/query token.
   *
   * Takes `WebhookVerifyCtx` (rawBody + headers) rather than a `Request`
   * so the route can read the body exactly once and hand the same bytes to
   * both verifyWebhook and parseWebhook — re-reading `Request.body` isn't
   * possible, and re-serializing parsed JSON breaks Meta's HMAC. (Wave-2
   * interface adjustment; see WebhookVerifyCtx above.)
   */
  verifyWebhook(ctx: WebhookVerifyCtx, ch: ChannelCtx | null): Promise<boolean>;

  /** Turn a raw webhook body into normalized inbound messages + statuses. */
  parseWebhook(body: unknown): ParsedWebhook;

  /**
   * Resolve inbound media bytes when the webhook didn't inline them
   * (WAHA / Evolution). Called by the provider BEFORE it hands the
   * NormalizedInbound to the pipeline. EvoGo omits this entirely.
   */
  fetchInboundMedia?(
    ch: ChannelCtx,
    fetchKey: unknown,
  ): Promise<{ base64: string; mimetype: string } | null>;

  /**
   * Best-effort lookup of a contact's WhatsApp profile photo, returning
   * a (possibly short-lived, cross-origin) CDN URL the caller must
   * download + re-host — NOT stored directly. Used by the inbound
   * pipeline to backfill contacts.avatar_url. Returns null on no photo /
   * privacy / error. Optional: only the QR providers that expose it
   * implement it (WAHA today); Meta / Evolution / EvoGo may omit it.
   */
  fetchProfilePicture?(
    ch: ChannelCtx,
    phoneE164: string,
  ): Promise<{ url: string } | null>;

  /**
   * Best-effort lookup of a WhatsApp GROUP's photo, keyed by the group jid
   * (`<digits>@g.us`). Same contract/pipeline as `fetchProfilePicture` — the
   * caller must download + re-host the returned CDN URL, never store it
   * directly. Returns null on no photo / not-yet-propagated / error. Optional:
   * only the QR engines that expose group photos implement it (WAHA/gows).
   */
  fetchGroupPicture?(
    ch: ChannelCtx,
    groupJid: string,
  ): Promise<{ url: string } | null>;

  // ---- session lifecycle (non-official providers) ----
  startSession?(ch: ChannelCtx, webhookUrl: string): Promise<{ qr?: string }>;
  getState?(
    ch: ChannelCtx,
  ): Promise<{ status: string; phoneNumber?: string | null }>;
}

/**
 * Capability table — the single source of truth for what each provider
 * can do (mirrors the cheat-sheet in docs/fase4-multicanal.md). Registry
 * stubs and the real adapters both read from here so the flags can't
 * drift between the interface and the implementation.
 */
export const CAPABILITIES: Record<ProviderId, Capabilities> = {
  meta: {
    templates: true,
    session24hWindow: true,
    interactive: true,
    reactions: true,
    typing: false,
    qrPairing: false,
    inboundMedia: true,
    needsChatIdResolve: false,
    needsJitter: false,
  },
  waha: {
    templates: false,
    session24hWindow: false,
    interactive: false,
    reactions: true,
    typing: true,
    qrPairing: true,
    inboundMedia: true,
    needsChatIdResolve: true,
    needsJitter: true,
  },
  evolution: {
    templates: false,
    session24hWindow: false,
    interactive: false,
    reactions: true,
    typing: false,
    qrPairing: true,
    // Media arrives via a mandatory fetch (getBase64FromMediaMessage),
    // not inline — still available, so true.
    inboundMedia: true,
    needsChatIdResolve: false,
    needsJitter: true,
  },
  evogo: {
    templates: false,
    session24hWindow: false,
    interactive: false,
    reactions: true,
    typing: false,
    qrPairing: true,
    // Structural limitation: no inline base64, no fetch API.
    inboundMedia: false,
    needsChatIdResolve: false,
    needsJitter: true,
  },
};

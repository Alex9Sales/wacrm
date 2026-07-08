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

/** The shape `parseWebhook` returns. */
export interface ParsedWebhook {
  messages: NormalizedInbound[];
  statuses: NormalizedStatus[];
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
    qrPairing: true,
    // Structural limitation: no inline base64, no fetch API.
    inboundMedia: false,
    needsChatIdResolve: false,
    needsJitter: true,
  },
};

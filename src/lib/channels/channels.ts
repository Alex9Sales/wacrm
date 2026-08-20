// ============================================================
// Channel helpers (Phase 4).
//
// Load / create / update `channels` rows and translate between the
// on-disk shape (encrypted credentials TEXT + jsonb metadata) and the
// decrypted `ChannelCtx` the providers consume. Credentials are a
// provider-specific JSON blob stored as a single AES-256-GCM ciphertext
// (encryption.ts) — encryptCredentials/decryptCredentials own the
// JSON.stringify ⇄ JSON.parse round-trip so no caller handles raw
// ciphertext.
// ============================================================

import crypto from 'crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db, channels } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import type { ChannelCtx, ProviderId } from './provider';

/** JSON-encode a credentials object and encrypt it (AES-256-GCM). */
export function encryptCredentials(creds: Record<string, unknown>): string {
  return encrypt(JSON.stringify(creds));
}

/** Decrypt a credentials ciphertext and JSON-parse it back to an object. */
export function decryptCredentials(ciphertext: string): Record<string, unknown> {
  const parsed = JSON.parse(decrypt(ciphertext));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Decrypted channel credentials are not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The raw channels row shape we select. */
type ChannelRow = typeof channels.$inferSelect;

/**
 * Turn a raw DB row into the decrypted `ChannelCtx` providers consume.
 * Decryption failures throw — a channel with unreadable credentials is
 * unusable and callers must surface that rather than proceed silently.
 */
function toCtx(row: ChannelRow): ChannelCtx {
  return {
    id: row.id,
    accountId: row.accountId,
    provider: row.provider as ProviderId,
    name: row.name,
    phoneNumber: row.phoneNumber ?? null,
    credentials: decryptCredentials(row.credentials),
    providerMeta: (row.providerMeta ?? {}) as Record<string, unknown>,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    webhookSecret: row.webhookSecret,
  };
}

/** Load a single channel by id, decrypted. Null if not found. */
export async function loadChannel(channelId: string): Promise<ChannelCtx | null> {
  const row = firstOrNull(
    await db.select().from(channels).where(eq(channels.id, channelId)).limit(1),
  );
  return row ? toCtx(row) : null;
}

/**
 * Load a single channel by id AND account — use on tenant-scoped paths
 * so a channel id from one account can't be read by another.
 */
export async function loadChannelByAccount(
  accountId: string,
  channelId: string,
): Promise<ChannelCtx | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(and(eq(channels.accountId, accountId), eq(channels.id, channelId)))
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

/** List every channel for an account, decrypted. */
export async function listChannels(accountId: string): Promise<ChannelCtx[]> {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.accountId, accountId));
  return rows.map(toCtx);
}

/**
 * Resolve a Meta channel by its phone_number_id (inbound routing). The
 * partial unique index `channels_meta_pnid` guarantees at most one.
 */
export async function loadMetaChannelByPhoneNumberId(
  phoneNumberId: string,
): Promise<ChannelCtx | null> {
  // Matches the partial unique index `channels_meta_pnid` exactly:
  // provider = 'meta' AND provider_meta->>'phone_number_id' = $1.
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.provider, 'meta'),
          sql`${channels.providerMeta}->>'phone_number_id' = ${phoneNumberId}`,
        ),
      )
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

/**
 * Resolve um canal Instagram pelo id da conta IG (roteamento do webhook —
 * `entry[].id`). Casa o índice parcial `channels_ig_id`.
 */
export async function loadInstagramChannelByIgId(
  igId: string,
): Promise<ChannelCtx | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.provider, 'instagram'),
          sql`${channels.providerMeta}->>'ig_id' = ${igId}`,
        ),
      )
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

/**
 * Resolve um canal Messenger pelo id da Página do Facebook (roteamento do
 * webhook — `entry[].id`). Casa o índice parcial `channels_page_id`.
 */
export async function loadMessengerChannelByPageId(
  pageId: string,
): Promise<ChannelCtx | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.provider, 'messenger'),
          sql`${channels.providerMeta}->>'page_id' = ${pageId}`,
        ),
      )
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

/** Roteamento do webhook de e-mail: acha o canal pelo endereço de DESTINO,
 *  case-insensitive. Casa tanto o `address` (canal hospedado, ou a marca do
 *  cliente) quanto o `ingestAddress` (canal com domínio próprio: o cliente
 *  ENCAMINHA a marca dele → esse alias hospedado, então o e-mail chega aqui com
 *  `to` = ingestAddress). */
export async function loadEmailChannelByAddress(
  address: string,
): Promise<ChannelCtx | null> {
  const addr = address.trim().toLowerCase();
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.provider, 'email'),
          sql`(lower(${channels.providerMeta}->>'address') = ${addr}
               OR lower(${channels.providerMeta}->>'ingestAddress') = ${addr})`,
        ),
      )
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

/**
 * Load the account's default channel — for legacy paths that assumed a
 * single WhatsApp config (health checks, "the" account channel). Prefers
 * a connected channel, then a Meta channel, then any. Returns null if the
 * account has no channels yet.
 */
export async function loadDefaultChannel(
  accountId: string,
): Promise<ChannelCtx | null> {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.accountId, accountId));
  if (rows.length === 0) return null;
  const pick =
    rows.find((r) => r.status === 'connected') ??
    rows.find((r) => r.provider === 'meta') ??
    rows[0];
  return toCtx(pick);
}

/**
 * Load the account's Meta channel — for Meta-only features (templates,
 * WABA operations) that have no meaning on the non-official providers.
 * Returns null when the account has no Meta channel configured.
 */
export async function loadMetaChannelByAccount(
  accountId: string,
): Promise<ChannelCtx | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(eq(channels.accountId, accountId), eq(channels.provider, 'meta')),
      )
      .limit(1),
  );
  return row ? toCtx(row) : null;
}

export interface CreateChannelInput {
  provider: ProviderId;
  name: string;
  status?: string;
  phoneNumber?: string | null;
  /** Plaintext credentials object — encrypted before insert. */
  credentials: Record<string, unknown>;
  providerMeta?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** Optional explicit webhook secret; a random one is generated otherwise. */
  webhookSecret?: string;
}

/**
 * Create a channel. Generates a random webhook_secret when not supplied
 * and encrypts the credentials JSON. Returns the decrypted ctx.
 */
export async function createChannel(
  accountId: string,
  input: CreateChannelInput,
): Promise<ChannelCtx> {
  const webhookSecret = input.webhookSecret ?? crypto.randomBytes(24).toString('hex');
  const row = firstOrNull(
    await db
      .insert(channels)
      .values({
        accountId,
        provider: input.provider,
        name: input.name,
        status: input.status ?? 'disconnected',
        phoneNumber: input.phoneNumber ?? null,
        credentials: encryptCredentials(input.credentials),
        providerMeta: input.providerMeta ?? {},
        settings: input.settings ?? {},
        webhookSecret,
      })
      .returning(),
  );
  if (!row) throw new Error('createChannel: insert returned no row');
  return toCtx(row);
}

/** Update a channel's status (and optionally its known phone number). */
/** The only values channels.status allows (DB check `channels_status_check`). */
const VALID_CHANNEL_STATUS = new Set([
  'disconnected',
  'qr_pending',
  'connected',
  'error',
]);

export async function updateChannelStatus(
  channelId: string,
  status: string,
  phoneNumber?: string | null,
): Promise<void> {
  // Never write a value outside the DB enum — a provider reporting an
  // unmapped state (e.g. WAHA 'STARTING') would otherwise throw
  // channels_status_check and leave the row stale. Coerce the unknown to
  // 'disconnected' (safe transient) so the write always succeeds.
  const safeStatus = VALID_CHANNEL_STATUS.has(status) ? status : 'disconnected';
  await db
    .update(channels)
    .set({
      status: safeStatus,
      ...(phoneNumber !== undefined ? { phoneNumber } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(channels.id, channelId));
}

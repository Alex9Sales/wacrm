// ============================================================
// API key store — the *auth-path* data access for public API keys.
//
// Only the read side lives here, and deliberately so: the hash is the
// only credential, so `findActiveKeyByHash` is the moment that
// establishes the caller's account. The management side (list /
// create / revoke) runs in the dashboard route handlers under a real
// session. Keeping this surface tiny and read-only makes it easy to
// audit.
// ============================================================

import { eq } from 'drizzle-orm';

import { db, accounts, apiKeys } from '@/db';
import { firstOrNull } from '@/db/helpers';

/** Shape of an `api_keys` row as the auth path consumes it. */
export interface ApiKeyRow {
  id: string;
  account_id: string;
  created_by: string | null;
  name: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Look up an *active* key by its SHA-256 hash. Returns null if no
 * row matches, or if the matching row is revoked or expired — so
 * callers never have to re-check liveness.
 */
export async function findActiveKeyByHash(
  hash: string
): Promise<ApiKeyRow | null> {
  let data: ApiKeyRow | null;
  try {
    data = firstOrNull(
      await db
        .select({
          id: apiKeys.id,
          account_id: apiKeys.accountId,
          created_by: apiKeys.createdBy,
          name: apiKeys.name,
          scopes: apiKeys.scopes,
          expires_at: apiKeys.expiresAt,
          revoked_at: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hash))
        .limit(1)
    );
  } catch (err) {
    console.error(
      '[api-keys/store] lookup error:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
  if (!data) return null;

  // Liveness checks in JS rather than SQL so the failure modes are
  // explicit and the index stays a simple equality lookup.
  if (data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return data;
}

/**
 * Fetch the account name for a resolved key, so `/api/v1/me` and any
 * future endpoint can echo it without a second round trip in the
 * route. The key already proved account membership.
 */
export async function getAccountName(
  accountId: string
): Promise<string | null> {
  try {
    const row = firstOrNull(
      await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .limit(1)
    );
    return row?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort `last_used_at` bump. Fire-and-forget from the auth
 * path — a failed update just means the "last used" column lags;
 * it must never fail the request the caller is actually making.
 */
export function touchLastUsed(id: string): void {
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id))
    .catch((err: unknown) => {
      console.warn(
        '[api-keys/store] last_used_at bump failed:',
        err instanceof Error ? err.message : err
      );
    });
}

// ============================================================
// Account-level (workspace-wide) settings — a thin typed wrapper over the
// `account_settings.settings` jsonb blob. One row per account; missing rows
// or keys fall back to DEFAULTS so callers never deal with nulls.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, accountSettings } from '@/db'
import { firstOrNull } from '@/db/helpers'

export interface AccountSettings {
  /** Prefix outbound agent messages with the sender's name (WhatsApp
   *  shows it in bold), so the customer knows who is replying. */
  agentSignatureEnabled: boolean
  /** Transcribe inbound audio/voice notes to text (uses the account's
   *  OpenAI key). Off by default — it has a per-minute cost. */
  audioTranscriptionEnabled: boolean
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  agentSignatureEnabled: false,
  audioTranscriptionEnabled: false,
}

/** Read an account's settings, merged over the defaults. */
export async function getAccountSettings(
  accountId: string,
): Promise<AccountSettings> {
  const row = firstOrNull(
    await db
      .select({ settings: accountSettings.settings })
      .from(accountSettings)
      .where(eq(accountSettings.accountId, accountId))
      .limit(1),
  )
  const stored = (row?.settings ?? {}) as Partial<AccountSettings>
  return { ...DEFAULT_ACCOUNT_SETTINGS, ...stored }
}

/** Upsert a partial patch onto an account's settings. */
export async function updateAccountSettings(
  accountId: string,
  patch: Partial<AccountSettings>,
): Promise<AccountSettings> {
  const current = await getAccountSettings(accountId)
  const next = { ...current, ...patch }
  await db
    .insert(accountSettings)
    .values({ accountId, settings: next })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { settings: next, updatedAt: new Date().toISOString() },
    })
  return next
}

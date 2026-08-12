import { and, asc, desc, eq } from 'drizzle-orm'
import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { decrypt } from '@/lib/whatsapp/encryption'
import { toAiHoursMode } from './hours-gate'
import { pickAgentIdForChannel } from './agents'
import type { AiConfig } from './types'

const agentSelect = {
  id: aiConfigs.id,
  provider: aiConfigs.provider,
  model: aiConfigs.model,
  apiKey: aiConfigs.apiKey,
  systemPrompt: aiConfigs.systemPrompt,
  isActive: aiConfigs.isActive,
  autoReplyEnabled: aiConfigs.autoReplyEnabled,
  autoReplyChannelIds: aiConfigs.autoReplyChannelIds,
  autoReplyMaxPerConversation: aiConfigs.autoReplyMaxPerConversation,
  autoReplyHoursMode: aiConfigs.autoReplyHoursMode,
  autoReplyBufferSeconds: aiConfigs.autoReplyBufferSeconds,
  dealSuggestionsProactive: aiConfigs.dealSuggestionsProactive,
  embeddingsApiKey: aiConfigs.embeddingsApiKey,
  signatureName: aiConfigs.signatureName,
  signatureEnabled: aiConfigs.signatureEnabled,
}

type AgentRow = {
  id: string
  provider: string
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyChannelIds: string[] | null
  autoReplyMaxPerConversation: number
  autoReplyHoursMode: string
  autoReplyBufferSeconds: number
  dealSuggestionsProactive: boolean
  embeddingsApiKey: string | null
  signatureName: string | null
  signatureEnabled: boolean
}

/** Turn a raw agent row into a usable, decrypted AiConfig (or null when it
 *  isn't usable). Shared by every loader below. */
function finalizeAgent(
  accountId: string,
  row: AgentRow | null,
  requireActive: boolean,
): AiConfig | null {
  if (!row) return null
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.isActive) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured".
  if (!row.apiKey) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddingsApiKey) {
    try {
      embeddingsApiKey = decrypt(row.embeddingsApiKey)
    } catch {
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    id: row.id,
    provider: row.provider as 'openai' | 'anthropic',
    model: row.model,
    apiKey: decrypt(row.apiKey),
    systemPrompt: row.systemPrompt,
    isActive: row.isActive,
    autoReplyEnabled: row.autoReplyEnabled,
    autoReplyChannelIds: row.autoReplyChannelIds ?? [],
    autoReplyMaxPerConversation: row.autoReplyMaxPerConversation,
    autoReplyHoursMode: toAiHoursMode(row.autoReplyHoursMode),
    autoReplyBufferSeconds: row.autoReplyBufferSeconds,
    dealSuggestionsProactive: row.dealSuggestionsProactive,
    embeddingsApiKey,
    signatureName: row.signatureName,
    signatureEnabled: row.signatureEnabled,
  }
}

/**
 * Load + decrypt the account's DEFAULT agent for *use* (draft / pipelines /
 * playground fallback). Multi-agente (0074): an account can have several
 * agents; this returns the one flagged `is_default` (falls back to the oldest).
 * Returns null when there's none or the master switch is off. Throws only if
 * the stored key can't be decrypted (mismatched ENCRYPTION_KEY).
 */
export async function loadAiConfig(
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const row = firstOrNull(
    await db
      .select(agentSelect)
      .from(aiConfigs)
      .where(eq(aiConfigs.accountId, accountId))
      .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))
      .limit(1),
  )
  return finalizeAgent(accountId, row as AgentRow | null, requireActive)
}

/** Load + decrypt one specific agent (account-scoped). */
export async function loadAiConfigById(
  accountId: string,
  agentId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const row = firstOrNull(
    await db
      .select(agentSelect)
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.id, agentId)))
      .limit(1),
  )
  return finalizeAgent(accountId, row as AgentRow | null, requireActive)
}

/**
 * Load the agent that should handle a conversation on `channelId` (routing).
 * `requireAutoReply` restricts to agents with auto-reply on (inbound bot);
 * `fallbackDefault` uses the default agent when no agent claims the channel
 * (manual draft, which should always have something to run).
 */
export async function loadAiConfigForChannel(
  accountId: string,
  channelId: string | null,
  opts: {
    requireActive?: boolean
    requireAutoReply?: boolean
    fallbackDefault?: boolean
  } = {},
): Promise<AiConfig | null> {
  const { requireActive = true, requireAutoReply = false, fallbackDefault = false } = opts
  const agentId = await pickAgentIdForChannel(accountId, channelId, {
    requireAutoReply,
  })
  if (agentId) return loadAiConfigById(accountId, agentId, { requireActive })
  if (fallbackDefault) return loadAiConfig(accountId, { requireActive })
  return null
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  let encrypted: string | null = null
  try {
    const row = firstOrNull(
      await db
        .select({ embeddingsApiKey: aiConfigs.embeddingsApiKey })
        .from(aiConfigs)
        .where(eq(aiConfigs.accountId, accountId))
        .limit(1),
    )
    encrypted = row?.embeddingsApiKey ?? null
  } catch {
    // Mirrors the old `if (error) …` path: a read failure means "no
    // usable key", not a hard error for the ingest route.
    return { key: null, corrupt: false }
  }
  if (!encrypted) return { key: null, corrupt: false }
  try {
    return { key: decrypt(encrypted), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}

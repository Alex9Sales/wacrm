import { and, asc, desc, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'

// ============================================================
// Multi-agente (Fase A). `ai_configs` deixou de ser 1-por-conta: cada linha
// é um AGENTE. O roteamento de qual agente responde é por CANAL
// (autoReplyChannelIds). Um agente é o DEFAULT (catch-all / fallback).
// Este módulo NÃO descriptografa chaves — só lista e roteia. O load+decrypt
// de um agente específico fica em ./config (loadAiConfigById).
// ============================================================

export interface AgentSummary {
  id: string
  name: string
  isDefault: boolean
  provider: string
  model: string
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyChannelIds: string[]
  dealSuggestionsProactive: boolean
  hasKey: boolean
  updatedAt: string
}

/** All agents of an account, default first then oldest — powers the panel. */
export async function listAgentSummaries(
  accountId: string,
): Promise<AgentSummary[]> {
  const rows = await db
    .select({
      id: aiConfigs.id,
      name: aiConfigs.name,
      isDefault: aiConfigs.isDefault,
      provider: aiConfigs.provider,
      model: aiConfigs.model,
      isActive: aiConfigs.isActive,
      autoReplyEnabled: aiConfigs.autoReplyEnabled,
      autoReplyChannelIds: aiConfigs.autoReplyChannelIds,
      dealSuggestionsProactive: aiConfigs.dealSuggestionsProactive,
      apiKey: aiConfigs.apiKey,
      updatedAt: aiConfigs.updatedAt,
    })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))

  return rows.map((r) => ({
    id: r.id,
    name: r.name?.trim() || 'Agente',
    isDefault: r.isDefault,
    provider: r.provider,
    model: r.model,
    isActive: r.isActive,
    autoReplyEnabled: r.autoReplyEnabled,
    autoReplyChannelIds: r.autoReplyChannelIds ?? [],
    dealSuggestionsProactive: r.dealSuggestionsProactive,
    hasKey: !!r.apiKey,
    updatedAt: r.updatedAt,
  }))
}

/**
 * Cheap early-out for the inbound hot path: does the account have ANY active
 * agent with auto-reply on? One indexed query, so a non-AI account can bail
 * before the heavier conversation load + routing.
 */
export async function hasActiveAutoReplyAgent(
  accountId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: aiConfigs.id })
    .from(aiConfigs)
    .where(
      and(
        eq(aiConfigs.accountId, accountId),
        eq(aiConfigs.isActive, true),
        eq(aiConfigs.autoReplyEnabled, true),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Resolve the id of the DEFAULT agent (catch-all / fallback). Falls back to
 * the oldest agent when none is flagged default (shouldn't happen post-0074).
 */
export async function getDefaultAgentId(
  accountId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: aiConfigs.id, isDefault: aiConfigs.isDefault })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId))
    .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * Pick which agent should handle a conversation on `channelId`.
 *   1. An agent that EXPLICITLY lists this channel wins (a specific agent,
 *      not the default, is preferred when more than one matches).
 *   2. Otherwise a catch-all agent (empty channel list) — the default first.
 *   3. Otherwise none (the channel isn't covered → no reply).
 * With `requireAutoReply`, only active agents with auto-reply on are eligible
 * (inbound bot). Without it (manual draft), active is enough.
 *
 * Backward-compatible with the single-agent world: one default agent with a
 * non-empty channel list still gates to those channels; with an empty list it
 * is the catch-all for every channel — exactly the old behaviour.
 */
export async function pickAgentIdForChannel(
  accountId: string,
  channelId: string | null,
  opts: { requireAutoReply?: boolean } = {},
): Promise<string | null> {
  const conds = [
    eq(aiConfigs.accountId, accountId),
    eq(aiConfigs.isActive, true),
  ]
  if (opts.requireAutoReply) conds.push(eq(aiConfigs.autoReplyEnabled, true))

  const rows = await db
    .select({
      id: aiConfigs.id,
      isDefault: aiConfigs.isDefault,
      channelIds: aiConfigs.autoReplyChannelIds,
    })
    .from(aiConfigs)
    .where(and(...conds))
    .orderBy(asc(aiConfigs.createdAt))

  if (rows.length === 0) return null

  // 1) explicit channel match — prefer a non-default (specific) agent.
  if (channelId) {
    const explicit = rows.filter((r) => (r.channelIds ?? []).includes(channelId))
    if (explicit.length > 0) {
      return (explicit.find((r) => !r.isDefault) ?? explicit[0]).id
    }
  }

  // 2) catch-all (empty channel list) — só o DEFAULT cobre canal não listado.
  //    Especialista de roteamento (não-default, lista vazia) NÃO captura canal
  //    sozinho: ele só assume conversa por transferência ([[AGENTE:]] →
  //    conversations.ai_agent_id). Exceção: conta mono-agente sem default
  //    marcado mantém o comportamento antigo de catch-all.
  const catchAll = rows.filter((r) => (r.channelIds ?? []).length === 0)
  const defaultCatchAll = catchAll.find((r) => r.isDefault)
  if (defaultCatchAll) return defaultCatchAll.id
  if (catchAll.length > 0 && rows.length === 1) return catchAll[0].id

  // 3) no agent covers this channel.
  return null
}

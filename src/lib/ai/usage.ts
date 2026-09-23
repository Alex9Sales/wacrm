// ============================================================
// Fase B — Captura de uso de LLM (medidor de custo).
//
// Extrai os tokens da resposta de cada provedor NORMALIZANDO a semântica entre
// eles (ver ./pricing) e grava uma linha em `ai_usage`. A gravação é
// BEST-EFFORT: nunca lança no caminho da resposta — uma falha de captura não
// pode quebrar o atendimento (mesmo princípio do fazer.ai/agents).
// ============================================================

import { db, aiUsage } from '@/db'
import type { TokenUsage, UsageMeta } from './types'

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * OpenAI: `prompt_tokens` JÁ inclui os cacheados; o subconjunto lido do cache
 * vem em `prompt_tokens_details.cached_tokens`. Não há cobrança de escrita no
 * cache (o cache é automático) → `cacheCreationTokens = 0`.
 */
export function extractOpenAiUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown }
  }
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cachedReadTokens: num(u.prompt_tokens_details?.cached_tokens),
    cacheCreationTokens: 0,
  }
}

/**
 * Anthropic: `input_tokens` é o input NÃO-cacheado; `cache_read_input_tokens` e
 * `cache_creation_input_tokens` são contadores SEPARADOS (não entram em
 * `input_tokens`). Normalizamos `promptTokens` para o TOTAL de input =
 * input + cache_read + cache_creation, mantendo os subconjuntos.
 */
export function extractAnthropicUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation_input_tokens?: unknown
  }
  const cachedRead = num(u.cache_read_input_tokens)
  const cacheCreation = num(u.cache_creation_input_tokens)
  return {
    promptTokens: num(u.input_tokens) + cachedRead + cacheCreation,
    completionTokens: num(u.output_tokens),
    cachedReadTokens: cachedRead,
    cacheCreationTokens: cacheCreation,
  }
}

/**
 * Gemini reporta `usageMetadata`: promptTokenCount é o TOTAL de input (já
 * inclui o cache), candidatesTokenCount é o output e cachedContentTokenCount
 * é o subconjunto lido do cache. Não há "cache creation" separado.
 */
export function extractGeminiUsage(raw: unknown): TokenUsage {
  const u = (raw ?? {}) as {
    promptTokenCount?: unknown
    candidatesTokenCount?: unknown
    cachedContentTokenCount?: unknown
  }
  return {
    promptTokens: num(u.promptTokenCount),
    completionTokens: num(u.candidatesTokenCount),
    cachedReadTokens: num(u.cachedContentTokenCount),
    cacheCreationTokens: 0,
  }
}

/**
 * Uma captura sem consumo nenhum não vale gravar. Áudio conta: a transcrição
 * não gasta token, gasta MINUTO (23/09) — sem esta condição a nota de voz
 * ficaria de fora do medidor.
 */
export function isEmptyUsage(u: TokenUsage, audioSeconds = 0): boolean {
  return u.promptTokens === 0 && u.completionTokens === 0 && audioSeconds <= 0
}

/**
 * Grava uma linha append-only em `ai_usage`. BEST-EFFORT — engole qualquer erro
 * (a captura nunca pode derrubar a resposta). Ignora capturas vazias.
 */
export async function recordAiUsage(
  meta: UsageMeta,
  provider: string,
  model: string,
  usage: TokenUsage,
  /** Segundos de áudio transcritos — só a transcrição usa (cobrança por minuto). */
  audioSeconds = 0,
): Promise<void> {
  if (isEmptyUsage(usage, audioSeconds)) return
  try {
    await db.insert(aiUsage).values({
      audioSeconds: Math.max(0, Math.round(audioSeconds)),
      accountId: meta.accountId,
      agentId: meta.agentId ?? null,
      conversationId: meta.conversationId ?? null,
      channelId: meta.channelId ?? null,
      provider,
      model,
      source: meta.source,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedReadTokens: usage.cachedReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    })
  } catch (err) {
    console.error('[ai usage] falha ao gravar uso (ignorado):', err)
  }
}

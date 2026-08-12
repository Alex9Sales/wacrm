import {
  AiError,
  type AiConfig,
  type ChatMessage,
  type GenerateResult,
  type UsageMeta,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import type { ProviderResult } from './providers/shared'
import { recordAiUsage } from './usage'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Atribuição opcional (Fase B): quando presente, os tokens da chamada são
   *  gravados (best-effort) em `ai_usage` pra alimentar o medidor de custo. */
  meta?: UsageMeta
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, meta } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: ProviderResult
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  // Medidor de custo (Fase B): grava o uso quando o caller passou atribuição.
  // recordAiUsage é best-effort (engole erros), então nunca quebra a resposta.
  if (meta) {
    await recordAiUsage(meta, config.provider, config.model, result.usage)
  }

  return { ...parseGeneration(result.text), usage: result.usage }
}

/**
 * Split the raw model output into `{ text, handoff }`. The sentinel can
 * appear alone or trailing a partial reply; either way we treat the
 * turn as a handoff and strip the marker from any remaining text.
 */
export function parseGeneration(raw: string): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff }
}

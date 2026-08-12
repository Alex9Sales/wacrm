// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  /** O id do agente (ai_configs.id) — usado pra atribuir custo por agente
   *  (Fase B). Opcional só para não quebrar construções sintéticas de teste. */
  id?: string
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  /** Canais onde a IA responde automaticamente. Vazio = todos os canais. */
  autoReplyChannelIds: string[]
  autoReplyMaxPerConversation: number
  /** Horário de atendimento da IA: always | inside | outside (reusa o
   *  horário da conta). Fora da janela permitida, a IA não auto-responde. */
  autoReplyHoursMode: import('./hours-gate').AiHoursMode
  /** Buffer (s): espera após a última msg do cliente antes de responder.
   *  Opcional (default 8) para não quebrar construções sintéticas. */
  autoReplyBufferSeconds?: number
  /** IA proativa em Negociações (Fase 3): quando true, a IA analisa o negócio
   *  vinculado no inbound e cria sugestões pendentes. Opcional (default false)
   *  para não quebrar construções sintéticas. */
  dealSuggestionsProactive?: boolean
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Nome do atendente/agente que a IA representa (ex.: "Danyela"). */
  signatureName: string | null
  /** Quando true, as mensagens da IA vão assinadas com `signatureName`. */
  signatureEnabled: boolean
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Tokens de uma chamada de modelo, com semântica NORMALIZADA entre provedores
 * (Fase B): `promptTokens` é o TOTAL de input (inclui cache); `cachedReadTokens`
 * e `cacheCreationTokens` são subconjuntos dele. Ver src/lib/ai/pricing.ts.
 */
export interface TokenUsage {
  promptTokens: number
  completionTokens: number
  cachedReadTokens: number
  cacheCreationTokens: number
}

/** De onde partiu a chamada de IA (mantém teste separado do tráfego real). */
export type UsageSource =
  | 'inbox'
  | 'draft'
  | 'playground'
  | 'pipeline'
  | 'flow'
  | 'deal_suggest'
  | 'vision'
  | 'transcribe'
  | 'tts'
  | 'embeddings'

/**
 * Atribuição de uma chamada de IA para o medidor de custo. Quando passada a
 * `generateReply`, a captura de tokens é gravada (best-effort) em `ai_usage`.
 */
export interface UsageMeta {
  accountId: string
  agentId?: string | null
  conversationId?: string | null
  channelId?: string | null
  source: UsageSource
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Tokens consumidos (Fase B). Ausente se o provedor não reportou uso. */
  usage?: TokenUsage
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}

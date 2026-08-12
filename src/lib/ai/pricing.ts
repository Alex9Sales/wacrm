// ============================================================
// Fase B — Tabela de preços por modelo + cálculo de custo (US$ e R$).
//
// O medidor de custo é 100% local: a tabela `ai_usage` guarda só TOKENS e o
// custo é derivado aqui, a partir do preço por 1M de tokens de cada modelo.
// Sem Langfuse, sem serviço externo. Preços são editáveis à mão (mudam com o
// tempo) — mantê-los atualizados é a única manutenção.
//
// Semântica dos tokens (normalizada na captura, ver ./usage `normalize*Usage`):
//   promptTokens        = TOTAL de input (inclui cache) — base de cobrança
//   completionTokens    = output
//   cachedReadTokens    = subconjunto de promptTokens lido do cache (barato)
//   cacheCreationTokens = subconjunto escrito no cache (Anthropic, premium)
// ============================================================

/** Preço por 1.000.000 de tokens, em dólar. */
export interface ModelPrice {
  /** Input não-cacheado. */
  input: number
  /** Output (completion). */
  output: number
  /** Input lido do cache (desconto). Default = input quando ausente. */
  cachedInput?: number
  /** Escrita no cache (Anthropic ~1.25× input). Default = input quando ausente. */
  cacheWrite?: number
}

// Casamento por PREFIXO (o modelo configurado costuma ter sufixo de data/versão,
// ex.: "gpt-4o-mini-2024-07-18", "claude-3-5-sonnet-20241022"). A busca pega o
// prefixo conhecido MAIS LONGO, então liste os mais específicos à vontade.
const PRICES: Record<string, ModelPrice> = {
  // ---- OpenAI (US$/1M) ----
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'gpt-5-mini': { input: 0.25, output: 2, cachedInput: 0.025 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cachedInput: 0.005 },
  'gpt-5': { input: 1.25, output: 10, cachedInput: 0.125 },
  'o4-mini': { input: 1.1, output: 4.4, cachedInput: 0.275 },
  'o3-mini': { input: 1.1, output: 4.4, cachedInput: 0.55 },
  'o3': { input: 2, output: 8, cachedInput: 0.5 },
  // ---- Anthropic (US$/1M) ----
  'claude-3-5-haiku': { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  'claude-haiku': { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
  'claude-3-5-sonnet': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-3-7-sonnet': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-sonnet': { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
  'claude-3-opus': { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  'claude-opus-4': { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
  'claude-opus': { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 },
}

// Fallback conservador para um modelo desconhecido (nunca zera o custo — melhor
// estimar do que sumir com a despesa). Aproxima um "mini/haiku" barato.
const FALLBACK: ModelPrice = { input: 0.5, output: 1.5, cachedInput: 0.1 }

/** Resolve o preço de um modelo pelo prefixo conhecido mais longo. */
export function priceForModel(model: string): { price: ModelPrice; known: boolean } {
  const key = (model || '').trim().toLowerCase()
  let best: string | null = null
  for (const prefix of Object.keys(PRICES)) {
    if (key.startsWith(prefix) && (best === null || prefix.length > best.length)) {
      best = prefix
    }
  }
  if (best) return { price: PRICES[best], known: true }
  return { price: FALLBACK, known: false }
}

/** Tokens de uma chamada (semântica normalizada, ver cabeçalho). */
export interface UsageTokens {
  promptTokens: number
  completionTokens: number
  cachedReadTokens: number
  cacheCreationTokens: number
}

/**
 * Custo em US$ de uma chamada. `promptTokens` é o TOTAL de input, então o
 * input não-cacheado = prompt − cachedRead − cacheCreation. Cada fatia é
 * cobrada no seu preço (cache lido barato, cache escrito premium).
 */
export function costUsd(model: string, u: UsageTokens): number {
  const { price } = priceForModel(model)
  const cachedRead = Math.max(0, u.cachedReadTokens)
  const cacheCreation = Math.max(0, u.cacheCreationTokens)
  const nonCached = Math.max(0, u.promptTokens - cachedRead - cacheCreation)
  const cachedInput = price.cachedInput ?? price.input
  const cacheWrite = price.cacheWrite ?? price.input
  const inputCost = nonCached * price.input + cachedRead * cachedInput + cacheCreation * cacheWrite
  const outputCost = Math.max(0, u.completionTokens) * price.output
  return (inputCost + outputCost) / 1_000_000
}

/** Câmbio US$→R$ para o "medidor R$". Env `USD_BRL_RATE`, default 5.40. */
export function usdToBrlRate(): number {
  const raw = Number(process.env.USD_BRL_RATE)
  return Number.isFinite(raw) && raw > 0 ? raw : 5.4
}

/** Converte um custo em US$ para R$ com o câmbio corrente. */
export function toBrl(usd: number): number {
  return usd * usdToBrlRate()
}

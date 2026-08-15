import { AiError } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { extractGeminiUsage } from '../usage'
import {
  mergeConsecutive,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
  type ProviderResult,
} from './shared'

// Google Gemini (Generative Language API). A chave vai no header
// x-goog-api-key (NUNCA na URL). O system prompt vai em system_instruction;
// os turnos viram `contents` com roles 'user'/'model' (assistant→model).
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// O Gemini (especialmente free tier) devolve 503 "high demand" em picos. Uma
// re-tentativa curta engole o pico sem perder a resposta. Só re-tenta em
// sobrecarga/limite (503/429) — 404/401/403 são permanentes.
const MAX_ATTEMPTS = 3
const RETRY_STATUSES = new Set([429, 503])

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  const contents = mergeConsecutive(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  })

  let lastError: AiError | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      // Timeout/rede: não re-tenta (gastaria outro timeout inteiro).
      throw toNetworkError(err)
    }

    if (!res.ok) {
      const httpErr = await providerHttpError('Gemini', res)
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        lastError = httpErr
        await sleep(attempt * 1000) // 1s, 2s
        continue
      }
      throw httpErr
    }

    const data = (await res.json().catch(() => null)) as GeminiResponse | null
    const text = (data?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p?.text ?? '')
      .join('')
    if (!text || !text.trim()) {
      throw new AiError('Gemini returned an empty response.', {
        code: 'empty_response',
      })
    }
    return { text, usage: extractGeminiUsage(data?.usageMetadata) }
  }

  throw lastError ?? new AiError('Gemini indisponível no momento.', {
    code: 'provider_error',
    status: 502,
  })
}

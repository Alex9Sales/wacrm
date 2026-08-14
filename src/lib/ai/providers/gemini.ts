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

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: unknown
}

/**
 * Call Gemini's generateContent with the caller's own key. Returns the raw
 * assistant text + token usage (handoff parsing + usage recording ficam no
 * `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  const contents = mergeConsecutive(messages).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  let res: Response
  try {
    res = await fetch(
      `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
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

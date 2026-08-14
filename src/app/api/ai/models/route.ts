import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db, aiConfigs, aiCredentials } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiProvider } from '@/lib/ai/types'

/**
 * POST /api/ai/models  (admin+)
 *
 * List the models available on the provider for the given key, so the config
 * UI can offer a picker instead of a free-text field. When `api_key` is omitted
 * the stored key is used (re-list after a save). Never accepts the key via the
 * URL — always in the POST body. Returns `{ models: string[] }` (chat-capable,
 * newest-ish first); on failure returns 400 with a message.
 */

/** Keep chat-capable OpenAI models; drop embeddings/audio/image/etc. */
function isChatOpenAiModel(id: string): boolean {
  if (!/^(gpt-|o1|o3|o4|chatgpt)/.test(id)) return false
  return !/(embedding|whisper|tts|audio|realtime|transcribe|dall-e|image|moderation|search|instruct)/.test(
    id,
  )
}

async function listOpenAiModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const msg = res.status === 401 ? 'Chave inválida.' : `Falha ao listar modelos (HTTP ${res.status}).`
    throw new Error(msg)
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: string }[]
  } | null
  const ids = (data?.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && isChatOpenAiModel(id))
  return ids.sort((a, b) => b.localeCompare(a))
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  })
  if (!res.ok) {
    const msg = res.status === 401 ? 'Chave inválida.' : `Falha ao listar modelos (HTTP ${res.status}).`
    throw new Error(msg)
  }
  const data = (await res.json().catch(() => null)) as {
    data?: { id?: string }[]
  } | null
  const ids = (data?.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
  return ids.sort((a, b) => b.localeCompare(a))
}

/** Modelos Gemini que suportam generateContent (chat), sem o prefixo models/. */
async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    { headers: { 'x-goog-api-key': apiKey } },
  )
  if (!res.ok) {
    const msg =
      res.status === 400 || res.status === 401 || res.status === 403
        ? 'Chave inválida.'
        : `Falha ao listar modelos (HTTP ${res.status}).`
    throw new Error(msg)
  }
  const data = (await res.json().catch(() => null)) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[]
  } | null
  const ids = (data?.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter((id): id is string => typeof id === 'string' && id.startsWith('gemini'))
  return ids.sort((a, b) => b.localeCompare(a))
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = await checkRateLimit(`ai-models:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    if (
      provider !== 'openai' &&
      provider !== 'anthropic' &&
      provider !== 'gemini'
    ) {
      return NextResponse.json(
        { error: 'provider must be "openai", "anthropic" or "gemini"' },
        { status: 400 },
      )
    }

    // Credencial (Fase 2): lista os modelos com a chave da credencial escolhida.
    const credentialId =
      typeof body.credential_id === 'string' && body.credential_id.trim()
        ? body.credential_id.trim()
        : null

    // Freshly-typed key wins; senão credencial; senão a chave embutida.
    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKeyPlain = rawKey
    if (!apiKeyPlain && credentialId) {
      const cred = firstOrNull(
        await db
          .select({ apiKey: aiCredentials.apiKey })
          .from(aiCredentials)
          .where(
            and(
              eq(aiCredentials.id, credentialId),
              eq(aiCredentials.accountId, accountId),
            ),
          )
          .limit(1),
      )
      if (!cred?.apiKey) {
        return NextResponse.json(
          { error: 'Credencial não encontrada.' },
          { status: 400 },
        )
      }
      try {
        apiKeyPlain = decrypt(cred.apiKey)
      } catch {
        return NextResponse.json(
          { error: 'A chave da credencial não pôde ser lida.' },
          { status: 400 },
        )
      }
    }
    if (!apiKeyPlain) {
      const existing = firstOrNull(
        await db
          .select({ apiKey: aiConfigs.apiKey })
          .from(aiConfigs)
          .where(eq(aiConfigs.accountId, accountId))
          .limit(1),
      )
      if (!existing?.apiKey) {
        return NextResponse.json(
          { error: 'Informe uma chave para listar os modelos.' },
          { status: 400 },
        )
      }
      try {
        apiKeyPlain = decrypt(existing.apiKey)
      } catch {
        return NextResponse.json(
          { error: 'A chave salva não pôde ser lida — reinsira a chave.' },
          { status: 400 },
        )
      }
    }

    try {
      const models =
        provider === 'openai'
          ? await listOpenAiModels(apiKeyPlain)
          : provider === 'gemini'
            ? await listGeminiModels(apiKeyPlain)
            : await listAnthropicModels(apiKeyPlain)
      return NextResponse.json({ models })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Falha ao listar modelos.' },
        { status: 400 },
      )
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}

import { NextResponse } from 'next/server'
import { and, asc, desc, eq } from 'drizzle-orm'
import { db, aiConfigs, aiCredentials, pipelines } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'
import { toAiHoursMode } from '@/lib/ai/hours-gate'
import { sanitizeTools } from '@/lib/ai/tools'
import { sanitizeAutonomy } from '@/lib/ai/autonomy'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET(request: Request) {
  try {
    const { accountId } = await getCurrentAccount()
    // Multi-agente: ?agent=<id> lê um agente específico; sem param, o default.
    const requestedAgentId = new URL(request.url).searchParams.get('agent')

    const data = firstOrNull(
      await db
        .select({
          id: aiConfigs.id,
          name: aiConfigs.name,
          is_default: aiConfigs.isDefault,
          // `api_key` is selected only to derive `has_key` — it is
          // stripped out below and never returned to the client.
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          credential_id: aiConfigs.credentialId,
          system_prompt: aiConfigs.systemPrompt,
          is_active: aiConfigs.isActive,
          auto_reply_enabled: aiConfigs.autoReplyEnabled,
          auto_reply_channel_ids: aiConfigs.autoReplyChannelIds,
          knowledge_base_ids: aiConfigs.knowledgeBaseIds,
          auto_reply_max_per_conversation: aiConfigs.autoReplyMaxPerConversation,
          auto_reply_hours_mode: aiConfigs.autoReplyHoursMode,
          auto_reply_buffer_seconds: aiConfigs.autoReplyBufferSeconds,
          barge_in_minutes: aiConfigs.bargeInMinutes,
          audio_replies_enabled: aiConfigs.audioRepliesEnabled,
          voice_id: aiConfigs.voiceId,
          autonomy: aiConfigs.autonomy,
          access: aiConfigs.access,
          pipeline_id: aiConfigs.pipelineId,
          deal_suggestions_proactive: aiConfigs.dealSuggestionsProactive,
          signature_name: aiConfigs.signatureName,
          signature_enabled: aiConfigs.signatureEnabled,
          auto_close_enabled: aiConfigs.autoCloseEnabled,
          auto_schedule_enabled: aiConfigs.autoScheduleEnabled,
          tools: aiConfigs.tools,
          api_key: aiConfigs.apiKey,
          embeddings_api_key: aiConfigs.embeddingsApiKey,
        })
        .from(aiConfigs)
        .where(
          requestedAgentId
            ? and(
                eq(aiConfigs.accountId, accountId),
                eq(aiConfigs.id, requestedAgentId),
              )
            : eq(aiConfigs.accountId, accountId),
        )
        .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))
        .limit(1),
    )

    if (!data) return NextResponse.json({ configured: false })
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')

    const limit = await checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    // Credencial reutilizável (Fase 2): quando setada, provedor + chave vêm
    // DELA (não do body). credential_id ausente/vazio/null = caminho legado
    // (chave avulsa digitada no form). A chave da credencial é copiada pro
    // agente (api_key) como snapshot: se a credencial for removida depois, o
    // agente cai no fallback e continua funcionando.
    const credentialId =
      typeof body.credential_id === 'string' && body.credential_id.trim()
        ? body.credential_id.trim()
        : null
    let credential: { id: string; provider: string; apiKey: string } | null = null
    if (credentialId) {
      credential = firstOrNull(
        await db
          .select({
            id: aiCredentials.id,
            provider: aiCredentials.provider,
            apiKey: aiCredentials.apiKey,
          })
          .from(aiCredentials)
          .where(
            and(
              eq(aiCredentials.id, credentialId),
              eq(aiCredentials.accountId, accountId),
            ),
          )
          .limit(1),
      )
      if (!credential) return bad('Credencial não encontrada.')
    }

    const provider = (
      credential ? credential.provider : body.provider
    ) as AiProvider
    if (
      provider !== 'openai' &&
      provider !== 'anthropic' &&
      provider !== 'gemini'
    ) {
      return bad('provider must be "openai", "anthropic" or "gemini"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true
    // Canais onde a IA responde (multi). Vazio = todos os canais.
    const autoReplyChannelIds = Array.isArray(body.auto_reply_channel_ids)
      ? (body.auto_reply_channel_ids as unknown[]).filter(
          (x): x is string => typeof x === 'string' && !!x,
        )
      : []
    // Bases de conhecimento que ESTE agente usa (Fase K). Vazio = todas.
    const knowledgeBaseIds = Array.isArray(body.knowledge_base_ids)
      ? (body.knowledge_base_ids as unknown[]).filter(
          (x): x is string => typeof x === 'string' && !!x,
        )
      : []

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Horário de atendimento da IA: always | inside | outside.
    const autoReplyHoursMode = toAiHoursMode(body.auto_reply_hours_mode)

    // Buffer (s) do Agente IA — espera antes de responder (0..300).
    let bufferSeconds = Number(body.auto_reply_buffer_seconds)
    if (!Number.isFinite(bufferSeconds)) bufferSeconds = 8
    bufferSeconds = Math.min(300, Math.max(0, Math.floor(bufferSeconds)))

    // 🤫 Barge-in (min): humano respondeu → IA observa por N min (0..120; 0 = off).
    let bargeInMinutes = Number(body.barge_in_minutes)
    if (!Number.isFinite(bargeInMinutes)) bargeInMinutes = 5
    bargeInMinutes = Math.min(120, Math.max(0, Math.floor(bargeInMinutes)))

    // 🔊 Responder por áudio (master do TTS). Ausente = ligado (compat).
    const audioRepliesEnabled = body.audio_replies_enabled !== false
    // 🗣️ Voz ElevenLabs (voice_id). '' → null (volta pro OpenAI padrão).
    const voiceId =
      typeof body.voice_id === 'string' && body.voice_id.trim()
        ? body.voice_id.trim().slice(0, 100)
        : null

    // 🎛️ Autonomia governada (Fase 8): política por ação. Só grava quando o
    // form mandou o campo (preserva senão). sanitizeAutonomy filtra chaves/níveis.
    const autonomy =
      body.autonomy === undefined ? undefined : sanitizeAutonomy(body.autonomy)

    // 🔒 Trava de acesso (migr 0149): {tag_id, denied_message}. tag_id vazio
    // limpa a trava; tag inexistente na conta é rejeitada.
    let access: Record<string, string> | undefined = undefined
    if (body.access !== undefined) {
      const a = (body.access ?? {}) as Record<string, unknown>
      const tagId = typeof a.tag_id === 'string' && a.tag_id ? a.tag_id : null
      const deniedMessage =
        typeof a.denied_message === 'string'
          ? a.denied_message.trim().slice(0, 500)
          : ''
      if (tagId) {
        const { tags } = await import('@/db')
        const t = firstOrNull(
          await db
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.id, tagId), eq(tags.accountId, accountId)))
            .limit(1),
        )
        if (!t) return bad('Etiqueta da trava de acesso não encontrada.')
        access = { tagId, ...(deniedMessage ? { deniedMessage } : {}) }
      } else {
        access = {}
      }
    }

    // Funil DESTE agente (0139): string válida grava; null limpa; ausente preserva.
    let pipelineId: string | null | undefined = undefined
    if (body.pipeline_id === null) {
      pipelineId = null
    } else if (typeof body.pipeline_id === 'string' && body.pipeline_id.trim()) {
      const pipe = firstOrNull(
        await db
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(
            and(
              eq(pipelines.id, body.pipeline_id.trim()),
              eq(pipelines.accountId, accountId),
            ),
          )
          .limit(1),
      )
      if (!pipe) return bad('Funil não encontrado.')
      pipelineId = pipe.id
    }

    // Assinatura: nome do atendente que a IA representa + se assina as msgs.
    const signatureName =
      typeof body.signature_name === 'string' && body.signature_name.trim()
        ? body.signature_name.trim().slice(0, 60)
        : null
    const signatureEnabled = body.signature_enabled === true && !!signatureName
    // Ferramentas do agente (Fase A) — fonte da verdade. Só mexe se o form
    // mandou `tools` (senão preserva o que está salvo). Deriva os booleans
    // antigos (auto_close/auto_schedule) do conjunto, pra mantê-los coerentes.
    const tools = Array.isArray(body.tools) ? sanitizeTools(body.tools) : null
    const autoCloseEnabled = tools
      ? tools.includes('resolve') || tools.includes('move_card')
      : undefined
    const autoScheduleEnabled = tools ? tools.includes('schedule') : undefined

    // IA proativa em Negociações (Fase 3): opt-in por conta (default OFF).
    // IA proativa em Negociações agora é controlada FORA do agente (painel de
    // Agentes → card "IA em Negociações", via /api/ai/deal-proactive). Aqui só
    // PRESERVAMOS: se o campo não vier no body, não mexe no valor atual.
    const dealSuggestionsProactive =
      body?.deal_suggestions_proactive === undefined
        ? undefined
        : body.deal_suggestions_proactive === true

    // Multi-agente: nome do agente (rótulo do card) + qual agente editar.
    const agentName =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 60)
        : null
    const requestedAgentId =
      new URL(request.url).searchParams.get('agent') ||
      (typeof body.agent_id === 'string' ? body.agent_id : '')

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one. Multi-agente:
    // edita o agente pedido (agent_id / ?agent), senão o DEFAULT da conta.
    const existing = firstOrNull(
      await db
        .select({
          id: aiConfigs.id,
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          apiKey: aiConfigs.apiKey,
        })
        .from(aiConfigs)
        .where(
          requestedAgentId
            ? and(
                eq(aiConfigs.accountId, accountId),
                eq(aiConfigs.id, requestedAgentId),
              )
            : eq(aiConfigs.accountId, accountId),
        )
        .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))
        .limit(1),
    )
    if (requestedAgentId && !existing) return bad('Agente não encontrado.')

    // Caminho LEGADO (chave avulsa): resolve a chave e valida com o provedor.
    // Caminho CREDENCIAL pula tudo isso — a chave da credencial já foi validada
    // no cadastro e é reutilizada.
    if (!credential) {
    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.apiKey) {
      try {
        apiKeyPlain = decrypt(existing.apiKey)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyChannelIds: [],
          autoReplyMaxPerConversation: maxPer,
          autoReplyHoursMode: 'always',
          embeddingsApiKey: null,
          signatureName: null,
          signatureEnabled: false,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }
    } // fim do caminho legado (!credential)

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    // Chave a gravar em ai_configs.api_key: caminho credencial usa o blob
    // (criptografado) da credencial como snapshot; legado usa a chave avulsa.
    const apiKeyToStore: string | undefined = credential
      ? credential.apiKey
      : rawKey
        ? encrypt(rawKey)
        : undefined
    const shared: {
      name?: string
      provider: string
      model: string
      credentialId: string | null
      systemPrompt: string | null
      isActive: boolean
      autoReplyEnabled: boolean
      autoReplyChannelIds: string[]
      knowledgeBaseIds: string[]
      autoReplyMaxPerConversation: number
      autoReplyHoursMode: string
      autoReplyBufferSeconds: number
      bargeInMinutes: number
      audioRepliesEnabled: boolean
      voiceId: string | null
      autonomy?: Record<string, unknown>
      access?: Record<string, string>
      pipelineId?: string | null
      dealSuggestionsProactive?: boolean
      signatureName: string | null
      signatureEnabled: boolean
      autoCloseEnabled?: boolean
      autoScheduleEnabled?: boolean
      tools?: string[]
      embeddingsApiKey?: string | null
    } = {
      provider,
      model,
      // null quando é chave avulsa (legado) — desvincula de qualquer credencial.
      credentialId,
      systemPrompt,
      isActive,
      autoReplyEnabled,
      autoReplyChannelIds,
      knowledgeBaseIds,
      autoReplyMaxPerConversation: maxPer,
      autoReplyHoursMode,
      autoReplyBufferSeconds: bufferSeconds,
      bargeInMinutes,
      audioRepliesEnabled,
      voiceId,
      signatureName,
      signatureEnabled,
    }
    // Ferramentas: só grava quando o form mandou (preserva senão). Junto,
    // mantém os booleans antigos coerentes.
    if (tools) {
      shared.tools = tools
      shared.autoCloseEnabled = autoCloseEnabled
      shared.autoScheduleEnabled = autoScheduleEnabled
    }
    // IA proativa: só grava quando o campo veio no body (preserva o valor atual
    // caso contrário — o controle vive no card "IA em Negociações" do painel).
    if (dealSuggestionsProactive !== undefined) {
      shared.dealSuggestionsProactive = dealSuggestionsProactive
    }
    // Funil do agente: só grava quando o campo veio no body (preserva senão).
    if (pipelineId !== undefined) shared.pipelineId = pipelineId
    // Autonomia governada: só grava quando o form mandou (preserva senão).
    if (autonomy !== undefined) shared.autonomy = autonomy
    // Trava de acesso: só grava quando o form mandou (preserva senão).
    if (access !== undefined) shared.access = access
    if (rawEmbeddingsKey) {
      shared.embeddingsApiKey = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddingsApiKey = null
    }
    // Só grava o nome quando veio um — não apaga o rótulo existente num save
    // que mexeu só num toggle.
    if (agentName) shared.name = agentName

    try {
      if (existing) {
        await db
          .update(aiConfigs)
          .set(apiKeyToStore ? { ...shared, apiKey: apiKeyToStore } : shared)
          .where(eq(aiConfigs.id, existing.id))
      } else {
        // Primeiro agente da conta → é o default (catch-all/fallback).
        await db.insert(aiConfigs).values({
          accountId,
          createdBy: userId,
          isDefault: true,
          name: agentName || 'Agente principal',
          // Non-null garantido: credencial (snapshot) OU chave avulsa exigida.
          apiKey: apiKeyToStore!,
          ...shared,
        })
      }
    } catch (err) {
      console.error('[ai/config POST] save error:', err)
      return NextResponse.json(
        { error: 'Failed to save AI configuration' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    // Multi-agente: ?agent=<id> exclui UM agente; sem param, reset (o default).
    const agentId = new URL(request.url).searchParams.get('agent')
    try {
      if (agentId) {
        const agents = await db
          .select({ id: aiConfigs.id, isDefault: aiConfigs.isDefault })
          .from(aiConfigs)
          .where(eq(aiConfigs.accountId, accountId))
        const target = agents.find((a) => a.id === agentId)
        if (!target) return bad('Agente não encontrado.')
        // O principal só pode ser excluído se for o único (reset total).
        if (target.isDefault && agents.length > 1) {
          return bad('Torne outro agente o principal antes de excluir este.')
        }
        await db
          .delete(aiConfigs)
          .where(and(eq(aiConfigs.id, agentId), eq(aiConfigs.accountId, accountId)))
      } else {
        // Reset legado: apaga tudo da conta (recupera de chave corrompida).
        await db.delete(aiConfigs).where(eq(aiConfigs.accountId, accountId))
      }
    } catch (err) {
      console.error('[ai/config DELETE] error:', err)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

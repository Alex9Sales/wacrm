// ============================================================
// /api/v1/agents — o agente EXTERNO montando o time de agentes do CRM.
//
// GET  — lista os agentes da conta (id, nome, ativo, canais).
// POST — cria um agente novo HERDANDO o motor do agente padrão (provider/
//        modelo/chave/credencial) — o chamador só define nome, prompt,
//        canais e ferramentas. Requer que a conta já tenha um agente padrão
//        configurado (é de onde a chave de IA vem).
// Scope: agent:read / agent:write
// ============================================================

import { and, asc, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { sanitizeTools } from '@/lib/ai/tools'

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'agent:read')
    const rows = await db
      .select({
        id: aiConfigs.id,
        name: aiConfigs.name,
        is_default: aiConfigs.isDefault,
        is_active: aiConfigs.isActive,
        auto_reply_enabled: aiConfigs.autoReplyEnabled,
        auto_reply_channel_ids: aiConfigs.autoReplyChannelIds,
      })
      .from(aiConfigs)
      .where(eq(aiConfigs.accountId, ctx.accountId))
      .orderBy(asc(aiConfigs.createdAt))
    return ok({ agents: rows })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'agent:write')
    let body: {
      name?: unknown
      system_prompt?: unknown
      channel_ids?: unknown
      tools?: unknown
      active?: unknown
      auto_reply?: unknown
    }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const name =
      typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
    if (!name) throw badRequest("'name' is required")
    const systemPrompt =
      typeof body.system_prompt === 'string'
        ? body.system_prompt.trim().slice(0, 20000)
        : ''
    if (!systemPrompt) throw badRequest("'system_prompt' is required")
    const channelIds = Array.isArray(body.channel_ids)
      ? body.channel_ids.filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )
      : []
    const tools = Array.isArray(body.tools)
      ? sanitizeTools(body.tools)
      : undefined
    const active = body.active !== false
    const autoReply = body.auto_reply !== false

    // Motor herdado do agente PADRÃO (chave/credencial de IA da conta).
    const base = firstOrNull(
      await db
        .select({
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          apiKey: aiConfigs.apiKey,
          credentialId: aiConfigs.credentialId,
          embeddingsApiKey: aiConfigs.embeddingsApiKey,
        })
        .from(aiConfigs)
        .where(
          and(
            eq(aiConfigs.accountId, ctx.accountId),
            eq(aiConfigs.isDefault, true),
          ),
        )
        .limit(1),
    )
    if (!base)
      return fail(
        'bad_request',
        'Configure o agente padrão da conta primeiro (Agentes IA) — a chave de IA vem dele.',
        400,
      )

    const auditUserId = await resolveAuditUserId(ctx.accountId)
    const created = firstOrNull(
      await db
        .insert(aiConfigs)
        .values({
          accountId: ctx.accountId,
          createdBy: auditUserId,
          name,
          isDefault: false,
          provider: base.provider,
          model: base.model,
          apiKey: base.apiKey,
          credentialId: base.credentialId,
          embeddingsApiKey: base.embeddingsApiKey,
          systemPrompt,
          isActive: active,
          autoReplyEnabled: autoReply,
          autoReplyChannelIds: channelIds,
          ...(tools ? { tools } : {}),
        })
        .returning({ id: aiConfigs.id }),
    )
    if (!created) return fail('internal', 'Failed to create agent', 500)
    return ok({ id: created.id, name, active, channel_ids: channelIds }, 201)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

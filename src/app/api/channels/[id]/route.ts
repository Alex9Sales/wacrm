// ============================================================
// Single-channel route (Phase 4, wave 4A).
//
//   PATCH  /api/channels/:id  — rename and/or re-encrypt credentials/config.
//   DELETE /api/channels/:id  — delete the channel.
//
// Both admin-gated and account-scoped (loadChannelByAccount) so an id
// from another account can't be touched.
//
// DELETE + FK cascade: conversations.channel_id → channels(id) is
// ON DELETE CASCADE — deleting a channel that has conversations cascades
// to those conversations (and their messages). To avoid silently
// destroying inbox history, the DELETE handler BLOCKS with a 409 (carrying
// the conversation count) unless the caller opts in with `?force=true`, at
// which point the cascade is allowed to run.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq, sql, type SQL } from 'drizzle-orm'

import { db, aiConfigs, channels, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { removeDeletedChannel } from '@/lib/ai/agent-channels'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannelByAccount, encryptCredentials } from '@/lib/channels/channels'
import type { ChannelCtx, ProviderId } from '@/lib/channels/provider'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Turn a provider-specific `config` patch into a DELTA: the credential keys to
 * change and the provider_meta keys to set/remove. Omitted fields keep their
 * current value.
 *
 * 15/09 (Gmail GoLink): this used to return the whole provider_meta snapshot
 * read at the start of the request, and the PATCH wrote it back. The worker
 * writes the same column meanwhile (Gmail read position, channel health), so
 * saving a Pix key could roll the Gmail read position back or erase the
 * health warning. The PATCH now merges only what changed (jsonb `||` / `-`).
 */
function applyConfigPatch(
  ch: ChannelCtx,
  config: Record<string, unknown>,
): {
  credentials: Record<string, unknown> | null
  metaSet: Record<string, unknown>
  metaUnset: string[]
} {
  const credentials = { ...ch.credentials }
  let credentialsChanged = false
  const metaSet: Record<string, unknown> = {}
  const metaUnset: string[] = []
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined

  const setCred = (key: string, v: string | undefined) => {
    if (v !== undefined && credentials[key] !== v) {
      credentials[key] = v
      credentialsChanged = true
    }
  }
  const setMeta = (key: string, v: string | undefined) => {
    if (v !== undefined) metaSet[key] = v
  }

  switch (ch.provider as ProviderId) {
    case 'meta':
      setCred('accessToken', str(config.access_token))
      setCred('verifyToken', str(config.verify_token))
      setMeta('phone_number_id', str(config.phone_number_id))
      setMeta('waba_id', str(config.waba_id))
      break
    case 'waha':
      setCred('apiKey', str(config.api_key))
      setMeta('baseUrl', str(config.base_url))
      setMeta('session', str(config.session))
      break
    case 'evolution':
      setCred('apiKey', str(config.api_key))
      setMeta('baseUrl', str(config.base_url))
      setMeta('instance', str(config.instance))
      break
    case 'evogo':
      setCred('token', str(config.token))
      setMeta('baseUrl', str(config.base_url))
      break
  }

  // 🤖 E-mail/Gmail: ignorar e-mails automáticos (no-reply, alertas,
  // newsletters) — 15/09, GoLink. Booleano explícito liga/desliga.
  if ('ignore_automated' in config && (ch.provider === 'email' || ch.provider === 'gmail')) {
    if (typeof config.ignore_automated === 'boolean') metaSet.ignoreAutomated = config.ignore_automated
  }

  // Pix key — cross-provider, per channel (each number is a business with its
  // own key). null clears it.
  if ('pix' in config) {
    const p = config.pix as
      | { key?: unknown; keyType?: unknown; name?: unknown }
      | null
      | undefined
    if (p === null) {
      metaUnset.push('pix')
    } else if (p && typeof p.key === 'string' && p.key.trim()) {
      const keyType =
        typeof p.keyType === 'string' && p.keyType.trim()
          ? p.keyType.trim()
          : undefined
      const name =
        typeof p.name === 'string' && p.name.trim() ? p.name.trim() : undefined
      metaSet.pix = {
        key: p.key.trim(),
        ...(keyType ? { keyType } : {}),
        ...(name ? { name } : {}),
      }
    }
  }

  // Business location pin — cross-provider (each channel is a business with
  // its own address). The front sends parsed coords; null clears it.
  if ('location' in config) {
    const l = config.location as
      | { latitude?: unknown; longitude?: unknown; label?: unknown }
      | null
      | undefined
    if (l === null) {
      metaUnset.push('location')
    } else if (
      l &&
      typeof l.latitude === 'number' &&
      typeof l.longitude === 'number'
    ) {
      const label =
        typeof l.label === 'string' && l.label.trim() ? l.label.trim() : undefined
      metaSet.location = {
        latitude: l.latitude,
        longitude: l.longitude,
        ...(label ? { label } : {}),
      }
    }
  }

  return { credentials: credentialsChanged ? credentials : null, metaSet, metaUnset }
}

/** provider_meta = (atual - chaves removidas) || chaves novas — nunca o snapshot. */
function mergeProviderMetaSql(metaSet: Record<string, unknown>, metaUnset: string[]): SQL {
  let expr: SQL = sql`coalesce(${channels.providerMeta}, '{}'::jsonb)`
  for (const key of metaUnset) expr = sql`(${expr} - ${key}::text)`
  return sql`${expr} || ${JSON.stringify(metaSet)}::jsonb`
}

function isDuplicateNameError(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string }
  return (
    e?.code === '23505' ||
    e?.constraint === 'channels_account_id_name_key' ||
    (typeof e?.message === 'string' &&
      e.message.includes('channels_account_id_name_key'))
  )
}

/**
 * PATCH /api/channels/:id
 *
 * Body: { name?: string, config?: {...provider-specific} }. Renames the
 * channel and/or merges a config patch into its credentials + provider_meta
 * (re-encrypting credentials). At least one of name/config must be present.
 * Returns { id }.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const channel = await loadChannelByAccount(ctx.accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    const { name, config } = (body ?? {}) as {
      name?: unknown
      config?: Record<string, unknown>
    }

    const patch: {
      name?: string
      credentials?: string
      providerMeta?: SQL
      updatedAt: string
    } = { updatedAt: new Date().toISOString() }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return NextResponse.json(
          { error: 'name must be a non-empty string' },
          { status: 400 },
        )
      }
      patch.name = name.trim()
    }

    if (config !== undefined) {
      if (typeof config !== 'object' || config === null) {
        return NextResponse.json(
          { error: 'config must be an object' },
          { status: 400 },
        )
      }
      // Gmail: a senha de app tem rota própria (valida no Google e mantém o
      // ponto de leitura) e o endereço não muda (o ponto de leitura é da caixa).
      if (channel.provider === 'gmail' && ('app_password' in config || 'address' in config)) {
        return NextResponse.json(
          {
            error:
              'Para trocar a senha de app use o botão "Trocar senha de app" do canal. O endereço de um canal Gmail não pode ser trocado: crie um canal novo para outro Gmail.',
          },
          { status: 400 },
        )
      }
      const { credentials, metaSet, metaUnset } = applyConfigPatch(channel, config)
      if (credentials) patch.credentials = encryptCredentials(credentials)
      if (Object.keys(metaSet).length > 0 || metaUnset.length > 0) {
        patch.providerMeta = mergeProviderMetaSql(metaSet, metaUnset)
      }
    }

    if (patch.name === undefined && config === undefined) {
      return NextResponse.json(
        { error: 'Nothing to update: provide name and/or config' },
        { status: 400 },
      )
    }

    try {
      await db
        .update(channels)
        .set(patch)
        .where(
          and(eq(channels.accountId, ctx.accountId), eq(channels.id, id)),
        )
    } catch (err) {
      if (isDuplicateNameError(err)) {
        return NextResponse.json(
          { error: 'A channel with that name already exists.' },
          { status: 409 },
        )
      }
      throw err
    }

    return NextResponse.json({ id })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/channels/:id[?force=true]
 *
 * Account-scoped delete. Independent of the channel's session/connection
 * state — an errored or dropped channel can still be removed.
 *
 * When the channel still owns conversations:
 *   - Without `?force=true` → returns 409 with the conversation count, so
 *     the UI can warn that deleting will also wipe that history.
 *   - With `?force=true` → proceeds; conversations (and their messages)
 *     cascade-delete via the `conversations.channel_id` FK.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const channel = await loadChannelByAccount(ctx.accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const force = new URL(request.url).searchParams.get('force') === 'true'

    // Guard: unless forced, refuse to delete a channel that still owns
    // conversations. Report the count so the UI can confirm the cascade.
    if (!force) {
      const counted = firstOrNull(
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(conversations)
          .where(eq(conversations.channelId, id)),
      )
      const convCount = counted?.count ?? 0
      if (convCount > 0) {
        return NextResponse.json(
          {
            error: `This channel has ${convCount} conversation(s). Deleting it will also remove them and their history.`,
            conversationCount: convCount,
          },
          { status: 409 },
        )
      }
    }

    await db
      .delete(channels)
      .where(and(eq(channels.accountId, ctx.accountId), eq(channels.id, id)))

    // 🤖 Tira o canal apagado da lista dos agentes — com cuidado. Best-effort:
    // o canal já foi apagado, isto nunca derruba a resposta.
    try {
      await detachDeletedChannelFromAgents(ctx.accountId, id)
    } catch (err) {
      console.error(
        '[channels DELETE] limpar canal dos agentes falhou:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * 15/09 (produção): agentes ficavam com id de canal apagado na lista (CEMA,
 * Zelia, GoLink). Tira o id SÓ de quem continua com pelo menos 1 canal que
 * existe. Quem ficaria sem canal válido NÃO é mexido: lista vazia num agente
 * default = "responde em TODOS os canais" (agents.ts pickAgentIdForChannel) —
 * a tela do agente avisa "não responde em nenhum canal" e a pessoa escolhe.
 * FOR UPDATE: um "Salvar" do agente ao mesmo tempo não perde a edição.
 */
async function detachDeletedChannelFromAgents(accountId: string, deletedId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const agents = await tx
      .select({ id: aiConfigs.id, name: aiConfigs.name, channelIds: aiConfigs.autoReplyChannelIds })
      .from(aiConfigs)
      .where(eq(aiConfigs.accountId, accountId))
      .for('update')
    const withDeleted = agents.filter((a) => (a.channelIds ?? []).includes(deletedId))
    if (withDeleted.length === 0) return

    const existing = new Set(
      (
        await tx.select({ id: channels.id }).from(channels).where(eq(channels.accountId, accountId))
      ).map((c) => c.id),
    )
    for (const a of withDeleted) {
      const next = removeDeletedChannel(a.channelIds, deletedId, existing)
      if (!next) {
        console.warn(
          '[channels DELETE] agente ficaria sem canal válido — lista mantida:',
          JSON.stringify({ accountId, agentId: a.id, agentName: a.name, deletedChannelId: deletedId }),
        )
        continue
      }
      await tx
        .update(aiConfigs)
        .set({ autoReplyChannelIds: next, updatedAt: new Date().toISOString() })
        .where(and(eq(aiConfigs.id, a.id), eq(aiConfigs.accountId, accountId)))
      console.log(
        '[channels DELETE] canal apagado tirado do agente:',
        JSON.stringify({ accountId, agentId: a.id, deletedChannelId: deletedId, remaining: next.length }),
      )
    }
  })
}

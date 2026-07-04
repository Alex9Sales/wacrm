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
// ON DELETE ... — deleting a channel that has conversations would cascade
// (or orphan) those conversations. For v1 we take the safer route and
// BLOCK the delete with a 409 when the channel still has conversations,
// rather than silently destroying inbox history.
// ============================================================

import { NextResponse } from 'next/server'
import { and, eq, sql } from 'drizzle-orm'

import { db, channels, conversations } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannelByAccount, encryptCredentials } from '@/lib/channels/channels'
import type { ChannelCtx, ProviderId } from '@/lib/channels/provider'

interface RouteParams {
  params: Promise<{ id: string }>
}

/**
 * Merge a provider-specific `config` patch into the channel's existing
 * credentials + providerMeta. Only provided fields are updated; omitted
 * fields keep their current value. Returns the new credentials object
 * (plaintext, to be re-encrypted) and the new providerMeta.
 */
function applyConfigPatch(
  ch: ChannelCtx,
  config: Record<string, unknown>,
): { credentials: Record<string, unknown>; providerMeta: Record<string, unknown> } {
  const credentials = { ...ch.credentials }
  const providerMeta = { ...ch.providerMeta }
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined

  const setCred = (key: string, v: string | undefined) => {
    if (v !== undefined) credentials[key] = v
  }
  const setMeta = (key: string, v: string | undefined) => {
    if (v !== undefined) providerMeta[key] = v
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

  return { credentials, providerMeta }
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
      providerMeta?: Record<string, unknown>
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
      const { credentials, providerMeta } = applyConfigPatch(channel, config)
      patch.credentials = encryptCredentials(credentials)
      patch.providerMeta = providerMeta
    }

    if (patch.name === undefined && patch.credentials === undefined) {
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
 * DELETE /api/channels/:id
 *
 * Account-scoped delete. Blocks with 409 when the channel still has
 * conversations — deleting would cascade and wipe inbox history, so v1
 * requires the caller to migrate/close those first.
 */
export async function DELETE(_request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const channel = await loadChannelByAccount(ctx.accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    // Guard: refuse to delete a channel that still owns conversations. The
    // FK cascade would otherwise remove them (and their messages) — safer
    // to make the caller deal with them explicitly.
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
          error: `This channel has ${convCount} conversation(s). Delete or reassign them before removing the channel.`,
        },
        { status: 409 },
      )
    }

    await db
      .delete(channels)
      .where(and(eq(channels.accountId, ctx.accountId), eq(channels.id, id)))

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

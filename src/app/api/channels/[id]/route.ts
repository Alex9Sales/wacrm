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

  // Business location pin — cross-provider (each channel is a business with
  // its own address). The front sends parsed coords; null clears it.
  if ('location' in config) {
    const l = config.location as
      | { latitude?: unknown; longitude?: unknown; label?: unknown }
      | null
      | undefined
    if (l === null) {
      delete providerMeta.location
    } else if (
      l &&
      typeof l.latitude === 'number' &&
      typeof l.longitude === 'number'
    ) {
      const label =
        typeof l.label === 'string' && l.label.trim() ? l.label.trim() : undefined
      providerMeta.location = {
        latitude: l.latitude,
        longitude: l.longitude,
        ...(label ? { label } : {}),
      }
    }
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

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

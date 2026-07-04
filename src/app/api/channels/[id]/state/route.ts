// ============================================================
// Channel connection-state poll route (Phase 4, wave 4A).
//
//   GET /api/channels/:id/state
//
// Polled by the UI while a QR is pending. Reads the authoritative state
// from the provider (getState), persists it onto the channel, and returns
// { status }. Meta has no session lifecycle → its stored status is
// returned as-is.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadChannelByAccount, updateChannelStatus } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { and, eq } from 'drizzle-orm'

interface RouteParams {
  params: Promise<{ id: string }>
}

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const channel = await loadChannelByAccount(ctx.accountId, id)
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const provider = getProvider(channel.provider)
    if (!provider.getState) {
      // Meta / no session lifecycle: return the stored status unchanged.
      const row = firstOrNull(
        await db
          .select({ status: channels.status })
          .from(channels)
          .where(
            and(eq(channels.accountId, ctx.accountId), eq(channels.id, id)),
          )
          .limit(1),
      )
      return NextResponse.json({ status: row?.status ?? channel.provider })
    }

    const { status } = await provider.getState(channel)
    await updateChannelStatus(channel.id, status)
    return NextResponse.json({ status })
  } catch (err) {
    return toErrorResponse(err)
  }
}

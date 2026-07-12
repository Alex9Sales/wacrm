// ============================================================
// GET /api/channels/status — lightweight channel-health list for the
// global "channel down — reconnect" banner.
//
// Unlike GET /api/channels (admin-gated, returns provider_meta), this is
// readable by ANY account member so agents also see the heads-up when a
// session drops — they just can't re-pair (that stays admin-only). Returns
// only the non-sensitive fields the banner needs; never credentials,
// webhook_secret, or provider_meta.
//
// Stale-status guard: the stored `channels.status` can drift from the
// gateway's real state (a session recovers on its own, or a lifecycle
// webhook for the final WORKING transition never arrives), which would
// leave the banner alarming on a channel that's actually fine. So for any
// channel that LOOKS down, we confirm live via getState and persist the
// fresh value before answering. Connected channels (the common case) skip
// the extra call entirely — the reconcile only runs on the rare down one.
// ============================================================

import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db, channels } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  loadChannelByAccount,
  updateChannelStatus,
} from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import type { ProviderId } from '@/lib/channels/provider'

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const rows = await db
      .select({
        id: channels.id,
        provider: channels.provider,
        name: channels.name,
        status: channels.status,
        phoneNumber: channels.phoneNumber,
      })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))

    // Reconcile only the channels that look down — confirm with the gateway
    // so a stale DB status never raises a false "channel down" banner.
    const out = await Promise.all(
      rows.map(async (ch) => {
        if (ch.status === 'connected') return ch
        try {
          const provider = getProvider(ch.provider as ProviderId)
          if (!provider.getState) return ch
          const full = await loadChannelByAccount(ctx.accountId, ch.id)
          if (!full) return ch
          const { status, phoneNumber } = await provider.getState(full)
          if (status !== ch.status) {
            await updateChannelStatus(ch.id, status, phoneNumber ?? undefined)
          }
          return { ...ch, status }
        } catch {
          // Gateway unreachable — fall back to the stored status.
          return ch
        }
      }),
    )

    return NextResponse.json({
      channels: out.map((ch) => ({
        id: ch.id,
        provider: ch.provider,
        name: ch.name,
        status: ch.status,
        phone_number: ch.phoneNumber,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

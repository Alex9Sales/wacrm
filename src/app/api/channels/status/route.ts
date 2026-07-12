// ============================================================
// GET /api/channels/status — lightweight channel-health list for the
// global "channel down — reconnect" banner.
//
// Unlike GET /api/channels (admin-gated, returns provider_meta), this is
// readable by ANY account member so agents also see the heads-up when a
// session drops — they just can't re-pair (that stays admin-only). Returns
// only the non-sensitive fields the banner needs; never credentials,
// webhook_secret, or provider_meta.
// ============================================================

import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db, channels } from '@/db'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

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

    return NextResponse.json({
      channels: rows.map((ch) => ({
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

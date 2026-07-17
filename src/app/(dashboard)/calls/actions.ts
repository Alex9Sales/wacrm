'use server'

// ============================================================
// Server actions for the "Ligações" panel — the dialer needs the list of
// WhatsApp (waha) channels the agent can place a call FROM.
//
// Deliberately account-scoped (getCurrentAccount), NOT admin-gated: the
// existing GET /api/channels is requireRole('admin'), but a dialer is an
// AGENT tool — in a 30-seat account most agents are not admins. This mirrors
// listMetaChannels in broadcasts/actions.ts (same auth, safe columns only).
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { getCurrentAccount } from '@/lib/auth/account'

export interface DialerChannel {
  id: string
  name: string
  phone_number: string | null
  status: string | null
}

/** The account's waha channels, for the dialer's "call from" picker. Only the
 *  safe columns — never credentials or the webhook secret. */
export async function listWahaChannels(): Promise<DialerChannel[]> {
  const ctx = await getCurrentAccount()
  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      phone_number: channels.phoneNumber,
      status: channels.status,
    })
    .from(channels)
    .where(
      and(eq(channels.accountId, ctx.accountId), eq(channels.provider, 'waha')),
    )
    .orderBy(channels.name)
  return rows as DialerChannel[]
}

// ============================================================
// Resolve the account's Meta channel → { phoneNumberId, token } for the
// server-side calling routes. The token is decrypted here and NEVER sent to
// the browser. Returns null when the account has no Meta channel.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadMetaChannelByPhoneNumberId } from '@/lib/channels/channels'

export async function metaChannelForAccount(
  accountId: string,
): Promise<{ phoneNumberId: string; token: string } | null> {
  const row = firstOrNull(
    await db
      .select({
        pnid: sql<string>`${channels.providerMeta}->>'phone_number_id'`,
      })
      .from(channels)
      .where(
        and(eq(channels.accountId, accountId), eq(channels.provider, 'meta')),
      )
      .limit(1),
  )
  if (!row?.pnid) return null
  const channel = await loadMetaChannelByPhoneNumberId(row.pnid)
  const token = channel?.credentials.accessToken as string | undefined
  if (!channel || !token) return null
  return { phoneNumberId: row.pnid, token }
}

const GRAPH = 'https://graph.facebook.com/v21.0'

/** POST to the Graph API on behalf of a phone number. */
export async function graphPost(
  phoneNumberId: string,
  token: string,
  path: 'calls' | 'messages',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${GRAPH}/${phoneNumberId}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

// ============================================================
// Resolve a WAHA channel's *voice-calls engine* (waha-voip) and proxy call
// requests to it. This is the UNOFFICIAL calling path — the second option
// alongside the official Meta calling (meta-channel-for-account.ts).
//
// Calls run on a SEPARATE waha-voip service (the number is linked as an extra
// WhatsApp device), so the messaging WAHA is never touched. A channel opts in
// by carrying `providerMeta.calls = { baseUrl, session }` with the api key in
// its encrypted credentials (`callsApiKey`). For the pilot, env vars
// (WAHA_CALLS_BASE_URL / WAHA_CALLS_SESSION / WAHA_CALLS_API_KEY) provide a
// fallback so these routes work before the Settings UI writes providerMeta.
//
// The LID fix lives here (resolveCallChatId): waha-voip only rings when the
// call targets the canonical WhatsApp id (→ @lid). Sending the raw number
// routes to @s.whatsapp.net and never rings for LID-migrated accounts — the
// exact wall the old WaCalls hit. Same approach as the messaging provider's
// resolveChatId in providers/waha.ts.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { decryptCredentials } from '@/lib/channels/channels'

export interface WahaCallsCoords {
  baseUrl: string
  session: string
  apiKey: string
}

/**
 * Resolve the account's WAHA calls-engine coordinates, or null when the
 * account has no calls-capable WAHA channel. The api key is decrypted here
 * and NEVER sent to the browser.
 */
export async function wahaCallsForAccount(
  accountId: string,
): Promise<WahaCallsCoords | null> {
  const row = firstOrNull(
    await db
      .select()
      .from(channels)
      .where(
        and(eq(channels.accountId, accountId), eq(channels.provider, 'waha')),
      )
      .limit(1),
  )

  const meta = (row?.providerMeta ?? {}) as {
    calls?: { baseUrl?: string; session?: string }
  }
  const baseUrl = meta.calls?.baseUrl ?? process.env.WAHA_CALLS_BASE_URL
  const session =
    meta.calls?.session ?? process.env.WAHA_CALLS_SESSION ?? 'default'

  let apiKey: string | undefined
  if (row?.credentials) {
    try {
      apiKey = decryptCredentials(row.credentials).callsApiKey as
        | string
        | undefined
    } catch {
      /* unreadable credentials — fall back to env */
    }
  }
  apiKey = apiKey ?? process.env.WAHA_CALLS_API_KEY

  if (!baseUrl || !apiKey) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), session, apiKey }
}

/** POST to the waha-voip calls API for a session. `path` is the bit after
 *  `/api/{session}/calls/` (e.g. `start`, `end`, `${callId}/webrtc`). */
export async function wahaCallsPost(
  c: WahaCallsCoords,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${c.baseUrl}/api/${c.session}/calls/${path}`, {
    method: 'POST',
    headers: { 'X-Api-Key': c.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

/**
 * The LID fix: resolve a phone to the canonical WhatsApp chatId via
 * check-exists so the call actually rings. Returns null when the number is
 * not on WhatsApp. Mirrors providers/waha.ts resolveChatId, minus the
 * `${digits}@c.us` fallback — for calls we'd rather fail loudly than ring the
 * wrong (non-canonical) address that silently never connects.
 */
export async function resolveCallChatId(
  c: WahaCallsCoords,
  phone: string,
): Promise<string | null> {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return null
  try {
    const res = await fetch(
      `${c.baseUrl}/api/contacts/check-exists?phone=${encodeURIComponent(
        digits,
      )}&session=${encodeURIComponent(c.session)}`,
      { headers: { 'X-Api-Key': c.apiKey } },
    )
    if (!res.ok) return null
    const b = (await res.json().catch(() => null)) as {
      numberExists?: boolean
      chatId?: string
    } | null
    if (b?.numberExists && typeof b.chatId === 'string' && b.chatId) {
      return b.chatId
    }
  } catch {
    /* unreachable engine — treat as unresolved */
  }
  return null
}

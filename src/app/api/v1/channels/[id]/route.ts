// ============================================================
// GET /api/v1/channels/{id} — detail of one WhatsApp sending channel
//   (scope: broadcasts:send). Same shape as the list, scoped to the account.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { getProvider } from '@/lib/channels/registry'
import type { ProviderId } from '@/lib/channels/provider'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send')
    const { id } = await params
    let row = null
    try {
      row = firstOrNull(
        await db
          .select({
            id: channels.id,
            name: channels.name,
            provider: channels.provider,
            status: channels.status,
            phone_number: channels.phoneNumber,
          })
          .from(channels)
          .where(
            and(eq(channels.id, id), eq(channels.accountId, ctx.accountId)),
          )
          .limit(1),
      )
    } catch {
      row = null
    }
    if (!row) return fail('not_found', 'Channel not found', 404)
    return ok({
      data: {
        ...row,
        official: !getProvider(row.provider as ProviderId).capabilities
          .needsJitter,
      },
    })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

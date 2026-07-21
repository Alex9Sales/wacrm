// ============================================================
// GET /api/v1/broadcasts/{id}/recipients — per-recipient delivery status
//   (scope: broadcasts:send). Keyset-paginated. Each row: the contact's phone
//   + name and the recipient's status (pending/sent/delivered/read/failed/…),
//   so a caller (Hermes) can see exactly who got the broadcast and who failed.
//   Account-scoped via the parent broadcast.
// ============================================================

import { and, desc, eq, lt, or } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { parseListParams, buildPage } from '@/lib/api/v1/pagination'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send')
    const { id } = await params
    const { limit, cursor } = parseListParams(request)

    // Account ownership of the parent broadcast first.
    let owned = null
    try {
      owned = firstOrNull(
        await db
          .select({ id: broadcasts.id })
          .from(broadcasts)
          .where(
            and(eq(broadcasts.id, id), eq(broadcasts.accountId, ctx.accountId)),
          )
          .limit(1),
      )
    } catch {
      owned = null
    }
    if (!owned) return fail('not_found', 'Broadcast not found', 404)

    const conditions = [eq(broadcastRecipients.broadcastId, id)]
    if (cursor) {
      conditions.push(
        or(
          lt(broadcastRecipients.createdAt, cursor.createdAt),
          and(
            eq(broadcastRecipients.createdAt, cursor.createdAt),
            lt(broadcastRecipients.id, cursor.id),
          ),
        )!,
      )
    }
    const rows = await db
      .select({
        id: broadcastRecipients.id,
        contact_id: broadcastRecipients.contactId,
        status: broadcastRecipients.status,
        attempts: broadcastRecipients.attempts,
        whatsapp_message_id: broadcastRecipients.whatsappMessageId,
        sent_at: broadcastRecipients.sentAt,
        delivered_at: broadcastRecipients.deliveredAt,
        created_at: broadcastRecipients.createdAt,
        phone: contacts.phone,
        name: contacts.name,
      })
      .from(broadcastRecipients)
      .leftJoin(contacts, eq(broadcastRecipients.contactId, contacts.id))
      .where(and(...conditions))
      .orderBy(
        desc(broadcastRecipients.createdAt),
        desc(broadcastRecipients.id),
      )
      .limit(limit + 1)
    // created_at is defaulted (never null in practice) — coalesce for the keyset type.
    const norm = rows.map((r) => ({ ...r, created_at: r.created_at ?? '' }))
    const page = buildPage(norm, limit)
    return okList(page.items, page.nextCursor)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

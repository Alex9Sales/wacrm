// ============================================================
// DELETE /api/v1/scheduled-messages/:id — cancela uma agendada PENDENTE
// (status → 'cancelled'; o worker só envia 'pending', então é seguro).
// Scope: messages:send
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, scheduledMessages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'messages:send')
    const { id } = await params
    const row = firstOrNull(
      await db
        .update(scheduledMessages)
        .set({ status: 'cancelled' })
        .where(
          and(
            eq(scheduledMessages.id, id),
            eq(scheduledMessages.accountId, ctx.accountId),
            eq(scheduledMessages.status, 'pending'),
          ),
        )
        .returning({ id: scheduledMessages.id }),
    )
    if (!row)
      return fail('not_found', 'Pending scheduled message not found', 404)
    return ok({ id: row.id, status: 'cancelled' })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

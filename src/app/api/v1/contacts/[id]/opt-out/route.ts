// ============================================================
// POST /api/v1/contacts/:id/opt-out — marca/desmarca "não perturbe".
// Contato opted-out NUNCA recebe disparo, cadência nem reativação (as
// travas anti-ban do CRM respeitam o flag em todos os envios em massa).
// Body: { opted_out: boolean, reason?: string }
// Scope: contacts:write
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write')
    const { id } = await params
    let body: { opted_out?: unknown; reason?: unknown }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    if (typeof body.opted_out !== 'boolean')
      throw badRequest("'opted_out' must be true or false")
    const reason =
      typeof body.reason === 'string' ? body.reason.slice(0, 200) : null

    const row = firstOrNull(
      await db
        .update(contacts)
        .set(
          body.opted_out
            ? {
                optedOut: true,
                optedOutAt: new Date().toISOString(),
                optedOutReason: reason ?? 'via API',
              }
            : { optedOut: false, optedOutAt: null, optedOutReason: null },
        )
        .where(
          and(eq(contacts.id, id), eq(contacts.accountId, ctx.accountId)),
        )
        .returning({ id: contacts.id, optedOut: contacts.optedOut }),
    )
    if (!row) return fail('not_found', 'Contact not found', 404)
    return ok({ id: row.id, opted_out: row.optedOut })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

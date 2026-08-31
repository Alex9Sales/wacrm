// ============================================================
// GET /api/v1/cadences — lista as cadências da conta (sequências multicanal
// de mensagens fixas). Use o id em POST /cadences/:id/enroll pra inscrever
// um contato. Scope: cadences:read
// ============================================================

import { asc, eq, sql } from 'drizzle-orm'

import { db, cadences } from '@/db'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond'

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'cadences:read')
    const rows = await db
      .select({
        id: cadences.id,
        name: cadences.name,
        active: cadences.active,
        steps: sql<number>`(SELECT count(*)::int FROM cadence_steps cs WHERE cs.cadence_id = ${cadences.id})`,
      })
      .from(cadences)
      .where(eq(cadences.accountId, ctx.accountId))
      .orderBy(asc(cadences.name))
    return ok({ cadences: rows })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

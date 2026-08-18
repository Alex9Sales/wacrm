// ============================================================
// POST /api/v1/flows/{id}/activate — ativa/pausa/arquiva   (scope: flows:write)
//
// Body: { "status": "active" | "draft" | "archived" }. Ativar roda a mesma
// validação do construtor e recusa (400) se o fluxo estiver incompleto.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond'
import { setFlowStatus } from '@/lib/api/v1/flows'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'flows:write')
    const { id } = await context.params
    const body = (await request.json().catch(() => null)) as {
      status?: string
    } | null
    const status = body?.status
    if (status !== 'active' && status !== 'draft' && status !== 'archived') {
      throw badRequest("'status' deve ser 'active', 'draft' ou 'archived'.")
    }
    const flow = await setFlowStatus(ctx.accountId, id, status)
    if (!flow) return fail('not_found', 'Flow not found', 404)
    return ok(flow)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

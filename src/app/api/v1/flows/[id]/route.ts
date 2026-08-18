// ============================================================
// GET    /api/v1/flows/{id} — one flow + its nodes       (scope: flows:read)
// PATCH  /api/v1/flows/{id} — update (partial)            (scope: flows:write)
// DELETE /api/v1/flows/{id} — delete (cascade)            (scope: flows:write)
//
// PATCH: qualquer campo do fluxo. Se `nodes` vier no corpo, substitui o grafo
// inteiro (delete-then-insert). Se o fluxo ficar/estiver 'active', revalida.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond'
import {
  getFlow,
  updateFlow,
  deleteFlow,
  type FlowWriteInput,
} from '@/lib/api/v1/flows'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'flows:read')
    const { id } = await context.params
    const flow = await getFlow(ctx.accountId, id)
    if (!flow) return fail('not_found', 'Flow not found', 404)
    return ok(flow)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'flows:write')
    const { id } = await context.params
    const body = (await request.json().catch(() => null)) as FlowWriteInput | null
    if (!body || typeof body !== 'object') {
      throw badRequest('Request body must be a JSON object')
    }
    const flow = await updateFlow(ctx.accountId, id, body)
    if (!flow) return fail('not_found', 'Flow not found', 404)
    return ok(flow)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'flows:write')
    const { id } = await context.params
    const deleted = await deleteFlow(ctx.accountId, id)
    if (!deleted) return fail('not_found', 'Flow not found', 404)
    return ok({ deleted: true })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

// ============================================================
// GET  /api/v1/flows — list the account's flows        (scope: flows:read)
// POST /api/v1/flows — create a flow (+ nodes)          (scope: flows:write)
//
// Um "flow" é uma automação visual (estilo comentário→DM, menus, triagem),
// multicanal. O corpo do POST espelha o construtor: name, trigger_type,
// trigger_config, channel_id, entry_node_id, status, nodes[]. Os tipos de nó e
// seus campos: GET /api/v1/flows/node-types. Criar com status:'active' roda a
// validação de ativação e recusa (400) se faltar algo.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, okList, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { listFlows, createFlow, type FlowWriteInput } from '@/lib/api/v1/flows'

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'flows:read')
    const items = await listFlows(ctx.accountId)
    // Poucos fluxos por conta — sem paginação.
    return okList(items, null)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'flows:write')
    const body = (await request.json().catch(() => null)) as FlowWriteInput | null
    if (!body || typeof body !== 'object') {
      throw badRequest('Request body must be a JSON object')
    }
    const userId = await resolveAuditUserId(ctx.accountId)
    const flow = await createFlow(ctx.accountId, userId, body)
    return ok(flow, 201)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

// ============================================================
// POST /api/v1/cadences/:id/enroll — inscreve um contato na cadência.
// Os degraus viram mensagens agendadas no canal REAL do contato; a cadência
// PAUSA sozinha quando o cliente responde (comportamento nativo).
// Body: { contact_id, conversation_id?, deal_id? }
// Scope: cadences:write
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { enrollContactInCadence } from '@/lib/cadences/cadence'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'cadences:write')
    const { id: cadenceId } = await params
    let body: {
      contact_id?: unknown
      conversation_id?: unknown
      deal_id?: unknown
    }
    try {
      body = await request.json()
    } catch {
      throw badRequest('Invalid JSON body')
    }
    const contactId =
      typeof body.contact_id === 'string' ? body.contact_id : ''
    if (!contactId) throw badRequest("'contact_id' is required")

    const auditUserId = await resolveAuditUserId(ctx.accountId)
    const result = await enrollContactInCadence(
      { accountId: ctx.accountId, userId: auditUserId },
      {
        cadenceId,
        contactId,
        conversationId:
          typeof body.conversation_id === 'string'
            ? body.conversation_id
            : null,
        dealId: typeof body.deal_id === 'string' ? body.deal_id : null,
      },
    )
    if (!result.ok)
      return fail('bad_request', result.error ?? 'Enroll failed', 400)
    return ok(result, 201)
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

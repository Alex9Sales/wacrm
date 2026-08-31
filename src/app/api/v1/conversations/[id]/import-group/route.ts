// ============================================================
// POST /api/v1/conversations/:id/import-group — importa os PARTICIPANTES de
// um grupo de WhatsApp como contatos etiquetados (mesma feature do inbox).
// A conversa precisa ser de um GRUPO num canal WAHA. A etiqueta default é
// "Grupo: <nome>" (customizável via tag_name) — pronto pra segmentar disparo.
//
// Body: { tag_name?: string }
// Scope: contacts:write
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { importGroupMembersCore } from '@/lib/inbox/group-import'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:write')
    const { id: conversationId } = await params
    const body = (await request.json().catch(() => ({}))) as {
      tag_name?: unknown
    }
    const tagName =
      typeof body.tag_name === 'string' && body.tag_name.trim()
        ? body.tag_name.trim()
        : undefined

    const auditUserId = await resolveAuditUserId(ctx.accountId)
    const result = await importGroupMembersCore(
      ctx.accountId,
      auditUserId,
      conversationId,
      tagName,
    )
    if (!result.ok)
      return fail('bad_request', result.error ?? 'Import failed', 400)
    return ok({
      total_participants: result.total,
      contacts_created: result.contactsCreated,
      tagged: result.tagged,
      tag_name: result.tagName,
    })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

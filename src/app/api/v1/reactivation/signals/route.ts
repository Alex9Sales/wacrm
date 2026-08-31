// ============================================================
// GET /api/v1/reactivation/signals — "quem devo chamar de volta hoje?"
//
// A lista de sinais abertos do motor de recompra (CDL): recompra atrasada,
// na hora de recomprar, cliente sumido. Cada linha vem com nome/telefone,
// a conversa mais recente (se houver) e o payload do sinal (dias, média…).
// O agente externo pergunta isto de manhã e age com POST /reactivation/send.
// Query: ?type=repurchase_overdue|repurchase_due|inactive|high_value ?limit=
// Scope: contacts:read
// ============================================================

import { and, desc, eq, inArray } from 'drizzle-orm'

import { db, contacts, conversations } from '@/db'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, toApiErrorResponse, badRequest } from '@/lib/api/v1/respond'
import { listOpenSignals } from '@/lib/cdl/signals'

const TYPES = ['repurchase_overdue', 'repurchase_due', 'inactive', 'high_value']

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read')
    const url = new URL(request.url)
    const type = url.searchParams.get('type') ?? undefined
    if (type && !TYPES.includes(type))
      throw badRequest(`type must be one of: ${TYPES.join(', ')}`)
    const limit = Math.min(
      Math.max(Number(url.searchParams.get('limit')) || 100, 1),
      300,
    )

    const sigs = await listOpenSignals(ctx.accountId, { type, limit })
    if (sigs.length === 0) return ok({ signals: [] })

    const ids = [...new Set(sigs.map((s) => s.contactId))]
    const [cs, convs] = await Promise.all([
      db
        .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
        .from(contacts)
        .where(inArray(contacts.id, ids)),
      db
        .select({ id: conversations.id, contactId: conversations.contactId })
        .from(conversations)
        .where(
          and(
            eq(conversations.accountId, ctx.accountId),
            inArray(conversations.contactId, ids),
          ),
        )
        .orderBy(desc(conversations.createdAt)),
    ])
    const cmap = new Map(cs.map((c) => [c.id, c]))
    const convMap = new Map<string, string>()
    for (const cv of convs) {
      if (cv.contactId && !convMap.has(cv.contactId))
        convMap.set(cv.contactId, cv.id)
    }

    return ok({
      signals: sigs.map((s) => ({
        contact_id: s.contactId,
        name: cmap.get(s.contactId)?.name ?? null,
        phone: cmap.get(s.contactId)?.phone ?? null,
        conversation_id: convMap.get(s.contactId) ?? null,
        signal_type: s.signalType,
        severity: s.severity,
        payload: s.payload ?? {},
      })),
    })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

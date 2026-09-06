// ============================================================
// GET /api/v1/customers/:contactId/history — MEMÓRIA COMERCIAL do cliente.
//
// Dá ao agente externo o mesmo conhecimento que a IA nativa tem: métricas
// (nº de compras, total, ticket, frequência, última compra, preferências),
// as últimas transações, e o bloco `facts` em texto — pronto pra colar no
// contexto de um LLM ("CUSTOMER FACTS").
// Scope: contacts:read
// ============================================================

import { and, desc, eq, sql } from 'drizzle-orm'

import { db, contacts, customerMetrics, customerTransactions } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireApiKey } from '@/lib/auth/api-context'
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond'
import { buildCustomerFactsBlock } from '@/lib/cdl/metrics'
import { getAccountSettings } from '@/lib/settings/account-settings'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'contacts:read')
    const { contactId } = await params

    const contact = firstOrNull(
      await db
        .select({ id: contacts.id, name: contacts.name, phone: contacts.phone })
        .from(contacts)
        .where(
          and(eq(contacts.id, contactId), eq(contacts.accountId, ctx.accountId)),
        )
        .limit(1),
    )
    if (!contact) return fail('not_found', 'Contact not found', 404)

    const metrics = firstOrNull(
      await db
        .select()
        .from(customerMetrics)
        .where(
          and(
            eq(customerMetrics.accountId, ctx.accountId),
            eq(customerMetrics.contactId, contactId),
          ),
        )
        .limit(1),
    )
    const txs = await db
      .select({
        id: customerTransactions.id,
        type: customerTransactions.type,
        occurredAt: customerTransactions.occurredAt,
        amount: customerTransactions.amount,
        currency: customerTransactions.currency,
        paymentMethod: customerTransactions.paymentMethod,
        status: customerTransactions.status,
        metadata: customerTransactions.metadata,
      })
      .from(customerTransactions)
      .where(
        and(
          eq(customerTransactions.accountId, ctx.accountId),
          eq(customerTransactions.contactId, contactId),
          // 'merged' = a mesma venda vinda de outra fonte — já está na linha que ficou.
          sql`${customerTransactions.status} <> 'merged'`,
        ),
      )
      .orderBy(desc(customerTransactions.occurredAt))
      .limit(30)

    const tz = await getAccountSettings(ctx.accountId)
      .then((s) => s.businessTimezone || 'America/Sao_Paulo')
      .catch(() => 'America/Sao_Paulo')
    const facts = await buildCustomerFactsBlock(
      ctx.accountId,
      contactId,
      tz,
    ).catch(() => null)

    return ok({
      contact: { id: contact.id, name: contact.name, phone: contact.phone },
      metrics: metrics ?? null,
      transactions: txs,
      // Texto pronto pra contexto de LLM — o mesmo que a IA nativa usa.
      facts,
    })
  } catch (err) {
    return toApiErrorResponse(err)
  }
}

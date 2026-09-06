// ============================================================
// Fonte alternativa quando uma ferramenta externa falha: o que o CRM sabe.
//
// Leitura de cliente (buscar_cliente, ultima_compra, historico_compras) →
// memória comercial nativa (customer_metrics/transactions — o histórico
// importado). Escrita (criar_pedido…) → nota interna + aviso, porque o cliente
// pode ter confirmado uma compra que não foi registrada.
// Nunca lança. Sem 'server-only' — roda no worker.
// ============================================================

import { eq } from 'drizzle-orm'

import { db, contacts } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { buildCustomerFactsBlock } from '@/lib/cdl/metrics'

import { postInternalNote } from './close-actions'
import { fallbackKindFor, formatCrmFallback } from './tool-failure'

export async function crmFallbackForTool(args: {
  accountId: string
  contactId: string | null
  conversationId: string | null
  timezone: string
  slug: string
  risk: 'read' | 'write' | 'critical'
  failure: string
}): Promise<string> {
  const kind = fallbackKindFor(args.slug, args.risk)
  let contactName: string | null = null
  let facts: string | null = null
  try {
    if (args.contactId) {
      const c = firstOrNull(await db.select({ name: contacts.name }).from(contacts).where(eq(contacts.id, args.contactId)).limit(1))
      contactName = c?.name ?? null
      if (kind === 'customer') facts = await buildCustomerFactsBlock(args.accountId, args.contactId, args.timezone)
    }
  } catch (err) {
    console.error('[crm-fallback] leitura do CRM falhou:', err instanceof Error ? err.message : err)
  }
  if (kind === 'write' && args.conversationId) {
    await postInternalNote({
      conversationId: args.conversationId,
      text: `⚠️ A ferramenta ${args.slug} NÃO respondeu (${args.failure.slice(0, 140)}). Se o cliente confirmou a compra, registre o pedido na mão — a IA disse que ia confirmar em instantes.`,
    }).catch(() => {})
  }
  return formatCrmFallback({ kind, contactName, facts })
}

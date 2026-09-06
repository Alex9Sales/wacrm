// ============================================================
// 📊 Nunca duplicar o histórico de compras — a parte que grava.
//
// Uma venda que chega por um segundo caminho (planilha depois do ERP, ERP
// depois da planilha, Ganho no funil depois de qualquer um) NÃO vira linha
// nova: a linha existente é atualizada/ligada e a repetida é marcada
// `status='merged'` apontando para a que ficou. Nada é apagado — reversível.
// Quem decide o que é "a mesma venda" é same-sale.ts (puro, testado).
//
// Sem 'server-only' — o sync do ERP roda no worker.
// ============================================================

import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'

import { db, customerTransactions } from '@/db'
import { firstOrNull } from '@/db/helpers'

import { isSameSale, planMerges, sourceRank, type SaleLike } from './same-sale'

/** Status que NÃO contam como venda (cancelada, ou repetida de outra fonte). */
export const INACTIVE_TX_STATUSES = ['canceled', 'merged'] as const

interface TxRow {
  id: string
  source: string
  amount: string
  occurredAt: string
  dealId: string | null
  paymentMethod: string | null
  metadata: unknown
}

async function activeTxOf(accountId: string, contactId: string): Promise<TxRow[]> {
  return db
    .select({
      id: customerTransactions.id,
      source: customerTransactions.source,
      amount: customerTransactions.amount,
      occurredAt: customerTransactions.occurredAt,
      dealId: customerTransactions.dealId,
      paymentMethod: customerTransactions.paymentMethod,
      metadata: customerTransactions.metadata,
    })
    .from(customerTransactions)
    .where(
      and(
        eq(customerTransactions.accountId, accountId),
        eq(customerTransactions.contactId, contactId),
        notInArray(customerTransactions.status, [...INACTIVE_TX_STATUSES]),
      ),
    )
}

const asSale = (r: TxRow): SaleLike => ({ id: r.id, source: r.source, amount: Number(r.amount), occurredAt: r.occurredAt })

/**
 * Já existe esta venda vinda de OUTRA fonte? Devolve a candidata mais
 * confiável (erp > deal > import) e mais próxima no tempo — ou null.
 */
export async function findSameSale(args: {
  accountId: string
  contactId: string
  source: string
  amount: number
  occurredAt: string
}): Promise<TxRow | null> {
  const probe: SaleLike = { id: '__probe__', source: args.source, amount: args.amount, occurredAt: args.occurredAt }
  const rows = await activeTxOf(args.accountId, args.contactId)
  let best: TxRow | null = null
  let bestKey = Number.POSITIVE_INFINITY
  for (const r of rows) {
    if (!isSameSale(probe, asSale(r))) continue
    const dt = Math.abs(new Date(r.occurredAt).getTime() - new Date(args.occurredAt).getTime())
    const key = sourceRank(r.source) * 1e12 + dt
    if (key < bestKey) {
      best = r
      bestKey = key
    }
  }
  return best
}

/** Marca `loser` como repetida de `winner`. Idempotente. */
export async function markMerged(loserId: string, winnerId: string): Promise<void> {
  await db
    .update(customerTransactions)
    .set({
      status: 'merged',
      metadata: sql`coalesce(${customerTransactions.metadata}, '{}'::jsonb) || jsonb_build_object('merged_into', ${winnerId}::text, 'merged_at', now()::text)`,
      updatedAt: sql`now()`,
    })
    .where(eq(customerTransactions.id, loserId))
}

/**
 * Completa a linha que FICA com o que a repetida sabia e ela não: forma de
 * pagamento, produto, vínculo com o negócio. Nunca sobrescreve o que já tem.
 */
export async function enrichWinner(winner: TxRow, loser: Pick<TxRow, 'dealId' | 'paymentMethod' | 'metadata'>): Promise<void> {
  const wMeta = (winner.metadata ?? {}) as Record<string, unknown>
  const lMeta = (loser.metadata ?? {}) as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  if (!winner.dealId && loser.dealId) patch.dealId = loser.dealId
  if (!winner.paymentMethod && loser.paymentMethod) patch.paymentMethod = loser.paymentMethod
  const mergedMeta: Record<string, unknown> = { ...wMeta }
  for (const [k, v] of Object.entries(lMeta)) {
    if (mergedMeta[k] == null && v != null && k !== 'merged_into' && k !== 'merged_at') mergedMeta[k] = v
  }
  if (JSON.stringify(mergedMeta) !== JSON.stringify(wMeta)) patch.metadata = mergedMeta
  if (!Object.keys(patch).length) return
  await db
    .update(customerTransactions)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(customerTransactions.id, winner.id))
}

export interface AbsorbResult {
  merged: number
}

/**
 * Passa o pente num contato: linhas repetidas entre fontes somem dentro da
 * mais confiável. Usado pela limpeza da conta e depois de cada ingestão.
 */
export async function absorbDuplicatesForContact(accountId: string, contactId: string): Promise<AbsorbResult> {
  const rows = await activeTxOf(accountId, contactId)
  if (rows.length < 2) return { merged: 0 }
  const byId = new Map(rows.map((r) => [r.id, r]))
  const plan = planMerges(rows.map(asSale))
  for (const d of plan) {
    const winner = byId.get(d.keep.id)
    const loser = byId.get(d.merge.id)
    if (!winner || !loser) continue
    await enrichWinner(winner, loser)
    await markMerged(loser.id, winner.id)
  }
  return { merged: plan.length }
}

export interface CleanupResult {
  contactsChecked: number
  contactsChanged: number
  merged: number
}

/**
 * Limpeza da conta inteira: só contatos que TÊM chance de dobro (duas linhas
 * ativas de fontes diferentes com o mesmo valor em até 36h). Não recalcula
 * métricas — quem chama decide (é caro).
 */
export async function cleanupAccountDuplicates(accountId: string): Promise<CleanupResult & { contactIds: string[] }> {
  const candidates = await db.execute(sql`
    SELECT DISTINCT a.contact_id
    FROM customer_transactions a
    JOIN customer_transactions b
      ON b.account_id = a.account_id AND b.contact_id = a.contact_id AND b.id <> a.id
     AND b.source <> a.source
     AND abs(extract(epoch FROM (b.occurred_at - a.occurred_at))) <= 36 * 3600
     AND (b.amount = a.amount OR a.source = 'deal' OR b.source = 'deal')
    WHERE a.account_id = ${accountId}::uuid
      AND a.status NOT IN ('canceled', 'merged') AND b.status NOT IN ('canceled', 'merged')
  `)
  const ids = (candidates.rows as { contact_id: string }[]).map((r) => r.contact_id)
  let merged = 0
  let changed = 0
  for (const contactId of ids) {
    const r = await absorbDuplicatesForContact(accountId, contactId)
    if (r.merged) {
      merged += r.merged
      changed += 1
    }
  }
  return { contactsChecked: ids.length, contactsChanged: changed, merged, contactIds: ids }
}

/** Uma linha (por id) ainda conta como venda? */
export async function isActiveTransaction(id: string): Promise<boolean> {
  const r = firstOrNull(
    await db.select({ status: customerTransactions.status }).from(customerTransactions).where(eq(customerTransactions.id, id)).limit(1),
  )
  return !!r && !(INACTIVE_TX_STATUSES as readonly string[]).includes(r.status)
}

export { inArray }

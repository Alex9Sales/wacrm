// ============================================================
// Entrada GOTEJADA de leads (tabela `lead_drip_queue`, migr 0186).
//
// Zelo 18/09: 41 leads parados no RD, liberados pelo Renato — 10 por dia,
// todo dia. Cada linha é um `ingestLead` que só roda em `run_after`: contato,
// card, conversa e abertura nascem NA HORA do envio. Criar tudo de uma vez
// deixava dezenas de conversas vazias no topo da caixa de entrada por dias.
//
// O worker (`lead-drip-worker`, tick 2 min) chama `runLeadDripTick`. Poucos
// por rodada: o lote do dia sai espaçado (9h00, 9h03…), não em rajada.
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, asc, eq, lte, sql } from 'drizzle-orm'

import { db, leadDripQueue } from '@/db'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { ingestLead, type IngestLeadInput } from '@/lib/leads/ingest'

const MAX_ATTEMPTS = 3
const RETRY_AFTER_MS = 10 * 60_000

export async function runLeadDripTick(limit = 3): Promise<{ done: number; failed: number }> {
  let done = 0
  let failed = 0
  const due = await db
    .select({ id: leadDripQueue.id })
    .from(leadDripQueue)
    .where(and(eq(leadDripQueue.status, 'pending'), lte(leadDripQueue.runAfter, sql`now()`)))
    .orderBy(asc(leadDripQueue.runAfter))
    .limit(limit)
  for (const { id } of due) {
    // Pega a linha pra si (outro worker no deploy não processa a mesma).
    const [row] = await db
      .update(leadDripQueue)
      .set({ status: 'processing', attempts: sql`${leadDripQueue.attempts} + 1` })
      .where(and(eq(leadDripQueue.id, id), eq(leadDripQueue.status, 'pending')))
      .returning()
    if (!row) continue
    try {
      const auditUserId = await resolveAuditUserId(row.accountId)
      const r = await ingestLead(row.accountId, auditUserId, row.input as IngestLeadInput)
      await db
        .update(leadDripQueue)
        .set({
          status: 'done',
          processedAt: sql`now()`,
          lastError: null,
          result: {
            contactId: r.contactId,
            dealId: r.dealId,
            dealReused: r.dealReused,
            whatsappSent: r.whatsappSent,
          },
        })
        .where(eq(leadDripQueue.id, row.id))
      console.log(`[lead-drip] ${row.label}: ${r.whatsappSent ? 'abertura enviada' : 'SEM abertura'} (card ${r.dealId ?? '—'})`)
      done += 1
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500)
      const giveUp = row.attempts >= MAX_ATTEMPTS
      await db
        .update(leadDripQueue)
        .set({
          status: giveUp ? 'failed' : 'pending',
          lastError: msg,
          ...(giveUp
            ? { processedAt: sql`now()` }
            : { runAfter: new Date(Date.now() + RETRY_AFTER_MS).toISOString() }),
        })
        .where(eq(leadDripQueue.id, row.id))
      console.error(`[lead-drip] ${row.label} falhou (tentativa ${row.attempts}):`, msg)
      failed += 1
    }
  }
  return { done, failed }
}

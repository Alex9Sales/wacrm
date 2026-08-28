// ============================================================
// 📊 Customer Data Layer (Fase 3) — recomputa customer_metrics a partir de
// customer_transactions. CACHE recomputável, nunca fonte de verdade. Set-based
// (um upsert por chamada, agrupando por contato). Sem 'server-only' —
// worker-reachable (importador, e futuros hooks de escrita).
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'

/**
 * Recomputa as métricas dos contatos informados (ou de TODOS os contatos da
 * conta com transações, se `contactIds` vier vazio/null). Ignora transações
 * canceladas. Idempotente: recomputa do zero a partir do razão.
 */
export async function recomputeMetricsForContacts(
  accountId: string,
  contactIds?: string[] | null,
): Promise<void> {
  const filterByContacts =
    Array.isArray(contactIds) && contactIds.length > 0
      ? sql`AND ct.contact_id = ANY(${contactIds}::uuid[])`
      : sql``

  await db.execute(sql`
    WITH tx AS (
      SELECT contact_id, amount, occurred_at, payment_method,
             (metadata->>'product') AS product
      FROM customer_transactions ct
      WHERE ct.account_id = ${accountId}::uuid AND ct.status <> 'canceled'
      ${filterByContacts}
    ),
    agg AS (
      SELECT
        contact_id,
        count(*)::int AS cnt,
        COALESCE(sum(amount), 0) AS total,
        COALESCE(round(avg(amount), 2), 0) AS avg_ticket,
        min(occurred_at) AS first_at,
        max(occurred_at) AS last_at
      FROM tx GROUP BY contact_id
    ),
    last_amt AS (
      SELECT DISTINCT ON (contact_id) contact_id, amount
      FROM tx ORDER BY contact_id, occurred_at DESC
    ),
    pref_prod AS (
      SELECT contact_id, product FROM (
        SELECT contact_id, product,
          row_number() OVER (PARTITION BY contact_id
            ORDER BY count(*) DESC, max(occurred_at) DESC) AS rn
        FROM tx WHERE product IS NOT NULL GROUP BY contact_id, product
      ) z WHERE rn = 1
    ),
    pref_pay AS (
      SELECT contact_id, payment_method FROM (
        SELECT contact_id, payment_method,
          row_number() OVER (PARTITION BY contact_id
            ORDER BY count(*) DESC, max(occurred_at) DESC) AS rn
        FROM tx WHERE payment_method IS NOT NULL GROUP BY contact_id, payment_method
      ) z WHERE rn = 1
    )
    INSERT INTO customer_metrics (
      account_id, contact_id, transaction_count, total_revenue, average_ticket,
      first_transaction_at, last_transaction_at, last_transaction_amount,
      average_repurchase_days, preferred_product, preferred_payment_method,
      next_expected_at, updated_at
    )
    SELECT
      ${accountId}::uuid, agg.contact_id, agg.cnt, agg.total, agg.avg_ticket,
      agg.first_at, agg.last_at, la.amount,
      CASE WHEN agg.cnt > 1
        THEN round((EXTRACT(EPOCH FROM (agg.last_at - agg.first_at)) / 86400.0 / (agg.cnt - 1))::numeric, 2)
        ELSE NULL END,
      pp.product, ppay.payment_method,
      CASE WHEN agg.cnt > 1
        THEN agg.last_at + make_interval(days =>
          GREATEST(1, round(EXTRACT(EPOCH FROM (agg.last_at - agg.first_at)) / 86400.0 / (agg.cnt - 1))::int))
        ELSE NULL END,
      now()
    FROM agg
      LEFT JOIN last_amt  la   USING (contact_id)
      LEFT JOIN pref_prod pp   USING (contact_id)
      LEFT JOIN pref_pay  ppay USING (contact_id)
    ON CONFLICT (account_id, contact_id) DO UPDATE SET
      transaction_count        = EXCLUDED.transaction_count,
      total_revenue            = EXCLUDED.total_revenue,
      average_ticket           = EXCLUDED.average_ticket,
      first_transaction_at     = EXCLUDED.first_transaction_at,
      last_transaction_at      = EXCLUDED.last_transaction_at,
      last_transaction_amount  = EXCLUDED.last_transaction_amount,
      average_repurchase_days  = EXCLUDED.average_repurchase_days,
      preferred_product        = EXCLUDED.preferred_product,
      preferred_payment_method = EXCLUDED.preferred_payment_method,
      next_expected_at         = EXCLUDED.next_expected_at,
      updated_at               = now();
  `)
}

/** Recomputa TODAS as métricas da conta (backfill). */
export async function recomputeAccountMetrics(accountId: string): Promise<void> {
  await recomputeMetricsForContacts(accountId, null)
}

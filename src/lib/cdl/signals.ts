// ============================================================
// 📡 Customer Data Layer (Fase 7) — detector de SINAIS de recompra.
// Deriva de customer_metrics + o "agora": recompra_due (chegou a hora),
// recompra_overdue (atrasou), inactive (sumiu) e high_value (cliente valioso).
// Set-based e IDEMPOTENTE: upserta os sinais abertos e RESOLVE os que não se
// aplicam mais (cliente comprou de novo → o "atrasado" some sozinho).
// Sem 'server-only' — alcançável do worker.
//
// Delimitação (ver customer_signals.sql): deal_events = log imutável;
// customer_signals = estado ABERTO pra ação (aqui); notifications = entrega.
// ============================================================

import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { db, customerSignals } from '@/db'

/**
 * Recomputa os sinais abertos de uma conta a partir de customer_metrics.
 * Um único statement: CTE `desired` (o estado que deveria existir) → upsert
 * dos abertos → resolve os abertos que sumiram do `desired`.
 *
 * Regras (com pisos absolutos pra não virar spam em negócio de alta frequência):
 *   avg = average_repurchase_days ; ds = dias desde a última compra
 *   due_min      = avg * 0.85
 *   overdue_min  = max(avg * 1.25, 3 dias)
 *   inactive_min = max(avg * 3, 45 dias)
 *   inactive  se ds ≥ inactive_min
 *   overdue   se ds ≥ overdue_min
 *   due       se ds ≥ due_min
 *   (senão: cedo demais, sem sinal de recompra)
 *   high_value: transaction_count ≥ 5 (independente do estado de recompra)
 */
export async function recomputeSignalsForAccount(accountId: string): Promise<void> {
  await db.execute(sql`
    WITH base AS (
      SELECT
        m.contact_id,
        m.average_repurchase_days::float8 AS avg,
        (EXTRACT(EPOCH FROM (now() - m.last_transaction_at)) / 86400.0)::float8 AS ds,
        m.preferred_product AS product,
        m.last_transaction_amount AS last_amount,
        m.transaction_count AS cnt,
        m.total_revenue AS total,
        m.next_expected_at AS next_at
      FROM customer_metrics m
      WHERE m.account_id = ${accountId}::uuid
        AND m.last_transaction_at IS NOT NULL
        AND m.average_repurchase_days IS NOT NULL
        AND m.average_repurchase_days > 0
        AND m.transaction_count >= 2
    ),
    repurchase AS (
      SELECT
        contact_id,
        CASE
          WHEN ds >= GREATEST(avg * 3, 45)   THEN 'inactive'
          WHEN ds >= GREATEST(avg * 1.25, 3) THEN 'repurchase_overdue'
          WHEN ds >= avg * 0.85              THEN 'repurchase_due'
          ELSE NULL
        END AS signal_type,
        ds, avg, product, last_amount, next_at
      FROM base
    ),
    desired AS (
      SELECT
        contact_id,
        signal_type,
        (CASE signal_type
          WHEN 'repurchase_due'     THEN 50
          WHEN 'repurchase_overdue' THEN LEAST(95, 60 + floor((ds / NULLIF(avg,0) - 1.25) * 25))::int
          WHEN 'inactive'           THEN LEAST(100, 70 + floor(ds / 30.0))::int
          ELSE 0
        END) AS severity,
        jsonb_strip_nulls(jsonb_build_object(
          'days_since', round(ds)::int,
          'avg_days', round(avg)::int,
          'product', product,
          'last_amount', last_amount,
          'next_expected_at', next_at
        )) AS payload
      FROM repurchase
      WHERE signal_type IS NOT NULL
      UNION ALL
      SELECT
        contact_id,
        'high_value' AS signal_type,
        (50 + LEAST(40, cnt))::int AS severity,
        jsonb_build_object('transaction_count', cnt, 'total_revenue', total) AS payload
      FROM base
      WHERE cnt >= 5
    ),
    ups AS (
      INSERT INTO customer_signals
        (account_id, contact_id, signal_type, severity, payload, detected_at, updated_at)
      SELECT ${accountId}::uuid, contact_id, signal_type, severity, payload, now(), now()
      FROM desired
      ON CONFLICT (account_id, contact_id, signal_type) WHERE resolved_at IS NULL
      DO UPDATE SET severity = EXCLUDED.severity, payload = EXCLUDED.payload, updated_at = now()
      RETURNING contact_id, signal_type
    )
    UPDATE customer_signals s
      SET resolved_at = now(), updated_at = now()
    WHERE s.account_id = ${accountId}::uuid
      AND s.resolved_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM desired d
        WHERE d.contact_id = s.contact_id AND d.signal_type = s.signal_type
      );
  `)
}

/** Recomputa os sinais de TODAS as contas que têm métricas (sweep do worker). */
export async function recomputeAllAccountSignals(): Promise<number> {
  const rows = await db.execute<{ account_id: string }>(
    sql`SELECT DISTINCT account_id FROM customer_metrics`,
  )
  const accounts = (rows.rows as { account_id: string }[]).map((r) => r.account_id)
  for (const acc of accounts) {
    try {
      await recomputeSignalsForAccount(acc)
    } catch (err) {
      console.error('[signals] conta', acc, 'falhou:', err)
    }
  }
  return accounts.length
}

export interface SignalRow {
  contactId: string
  signalType: string
  severity: number
  payload: Record<string, unknown>
  detectedAt: string
}

/** Sinais ABERTOS da conta (para a lista "chamar de volta"), mais urgentes 1º. */
export async function listOpenSignals(
  accountId: string,
  opts?: { type?: string; limit?: number },
): Promise<SignalRow[]> {
  const rows = await db
    .select({
      contactId: customerSignals.contactId,
      signalType: customerSignals.signalType,
      severity: customerSignals.severity,
      payload: customerSignals.payload,
      detectedAt: customerSignals.detectedAt,
    })
    .from(customerSignals)
    .where(
      and(
        eq(customerSignals.accountId, accountId),
        isNull(customerSignals.resolvedAt),
        opts?.type ? eq(customerSignals.signalType, opts.type) : undefined,
      ),
    )
    .orderBy(desc(customerSignals.severity), desc(customerSignals.detectedAt))
    .limit(opts?.limit ?? 200)
  return rows as SignalRow[]
}

// ============================================================
// 🔎 Sinais da Fase 2 — detector (worker-reachable, SEM 'server-only').
//
// Um statement por conta, mesmo padrão do detector de recompra
// (lib/cdl/signals.ts): CTE `desired` = estado que DEVE existir → upsert dos
// abertos → auto-resolve dos que sumiram. Só mexe nos tipos DESTE módulo.
//
//   por NEGÓCIO (deal_id preenchido):
//   • proposal_idle   — proposta existe, não aceita, e o cliente não fala há ≥72h
//   • followup_due    — deals.next_follow_up_at venceu
//   • stale_deal      — parado na etapa há ≥ staleDealDays (config da conta)
//   • high_intent     — quente (temperature hot/quente ou qualificação ≥4) SEM proposta
//   por CONTATO (deal_id NULL):
//   • churn_risk      — ≥3 compras e ds entre 2× e 3× a média (antes do 'inactive')
//   • ticket_declining— ≥4 compras e última compra < 70% do ticket médio
//   • customer_reactivated — voltou a comprar (últimos 7d) depois de ≥2× a média parado
//   • approval_required — pedidos pendentes na fila há ≥12h (1 por contato)
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { getAccountSettings } from '@/lib/settings/account-settings'

export const ORCH_SIGNAL_TYPES = [
  'proposal_idle',
  'followup_due',
  'stale_deal',
  'high_intent',
  'churn_risk',
  'ticket_declining',
  'customer_reactivated',
  'approval_required',
] as const

export const PROPOSAL_IDLE_HOURS = 72

export async function recomputeOrchestrationSignals(accountId: string): Promise<void> {
  const settings = await getAccountSettings(accountId)
  const staleDays = Number.isFinite(settings.staleDealDays) ? Math.max(0, Math.floor(settings.staleDealDays)) : 7
  const typesList = sql.join(
    ORCH_SIGNAL_TYPES.map((t) => sql`${t}`),
    sql`, `,
  )

  await db.execute(sql`
    WITH open_deals AS (
      SELECT d.id AS deal_id, d.contact_id, d.assigned_to, d.conversation_id, d.next_follow_up_at,
             COALESCE(d.stage_changed_at, d.created_at) AS stage_since, d.temperature, d.qualification,
             d.value, d.title
      FROM deals d
      WHERE d.account_id = ${accountId}::uuid AND d.status = 'open' AND d.contact_id IS NOT NULL AND d.paused_at IS NULL
    ),
    last_msgs AS (
      SELECT m.conversation_id,
             MAX(m.created_at) FILTER (WHERE m.sender_type = 'customer') AS last_customer_at,
             MAX(m.created_at) FILTER (WHERE m.sender_type IN ('agent', 'bot')) AS last_team_at
      FROM messages m
      WHERE m.conversation_id IN (SELECT conversation_id FROM open_deals WHERE conversation_id IS NOT NULL)
      GROUP BY m.conversation_id
    ),
    props AS (
      SELECT p.deal_id, p.created_at, p.viewed_at, p.accepted_at
      FROM deal_proposals p
      WHERE p.deal_id IN (SELECT deal_id FROM open_deals)
    ),
    metrics AS (
      SELECT m.contact_id, m.transaction_count AS cnt,
             m.average_repurchase_days::float8 AS avg,
             (EXTRACT(EPOCH FROM (now() - m.last_transaction_at)) / 86400.0)::float8 AS ds,
             m.average_ticket::float8 AS avg_ticket, m.last_transaction_amount::float8 AS last_amount,
             m.preferred_product AS product, m.last_transaction_at
      FROM customer_metrics m
      WHERE m.account_id = ${accountId}::uuid AND m.last_transaction_at IS NOT NULL
    ),
    desired AS (
      -- proposta parada
      SELECT od.contact_id, od.deal_id, 'proposal_idle'::text AS signal_type,
             LEAST(95, 50 + FLOOR(EXTRACT(EPOCH FROM (now() - GREATEST(pr.created_at, COALESCE(lm.last_customer_at, pr.created_at)))) / 86400.0) * 10)::int AS severity,
             jsonb_strip_nulls(jsonb_build_object(
               'hours_idle', FLOOR(EXTRACT(EPOCH FROM (now() - GREATEST(pr.created_at, COALESCE(lm.last_customer_at, pr.created_at)))) / 3600.0),
               'viewed', pr.viewed_at IS NOT NULL,
               'deal_title', od.title, 'value', od.value, 'proposal_created_at', pr.created_at
             )) AS payload
      FROM open_deals od
      JOIN props pr ON pr.deal_id = od.deal_id
      LEFT JOIN last_msgs lm ON lm.conversation_id = od.conversation_id
      WHERE pr.accepted_at IS NULL
        AND GREATEST(pr.created_at, COALESCE(lm.last_customer_at, pr.created_at)) <= now() - (${PROPOSAL_IDLE_HOURS} * interval '1 hour')
      UNION ALL
      -- follow-up vencido
      SELECT od.contact_id, od.deal_id, 'followup_due',
             LEAST(90, 50 + FLOOR(EXTRACT(EPOCH FROM (now() - od.next_follow_up_at)) / 86400.0) * 5)::int,
             jsonb_strip_nulls(jsonb_build_object('due_at', od.next_follow_up_at, 'deal_title', od.title, 'value', od.value))
      FROM open_deals od
      WHERE od.next_follow_up_at IS NOT NULL AND od.next_follow_up_at <= now()
      UNION ALL
      -- parado na etapa
      SELECT od.contact_id, od.deal_id, 'stale_deal',
             LEAST(85, 40 + FLOOR(EXTRACT(EPOCH FROM (now() - od.stage_since)) / 86400.0) * 2)::int,
             jsonb_strip_nulls(jsonb_build_object('days_stale', FLOOR(EXTRACT(EPOCH FROM (now() - od.stage_since)) / 86400.0), 'deal_title', od.title, 'value', od.value))
      FROM open_deals od
      WHERE ${staleDays} > 0 AND od.stage_since <= now() - (${staleDays} * interval '1 day')
      UNION ALL
      -- quente sem proposta
      SELECT od.contact_id, od.deal_id, 'high_intent', 70,
             jsonb_strip_nulls(jsonb_build_object('temperature', od.temperature, 'qualification', od.qualification, 'deal_title', od.title, 'value', od.value))
      FROM open_deals od
      LEFT JOIN props pr ON pr.deal_id = od.deal_id
      WHERE pr.deal_id IS NULL AND (lower(COALESCE(od.temperature, '')) IN ('hot', 'quente') OR COALESCE(od.qualification, 0) >= 4)
      UNION ALL
      -- risco de churn (contato)
      SELECT m.contact_id, NULL::uuid, 'churn_risk',
             LEAST(90, 60 + FLOOR((m.ds / NULLIF(m.avg, 0) - 2) * 20))::int,
             jsonb_strip_nulls(jsonb_build_object('days_since', FLOOR(m.ds), 'avg_days', ROUND(m.avg::numeric), 'product', m.product))
      FROM metrics m
      WHERE m.cnt >= 3 AND m.avg > 0 AND m.ds >= m.avg * 2 AND m.ds < GREATEST(m.avg * 3, 45)
      UNION ALL
      -- ticket caindo (contato)
      SELECT m.contact_id, NULL::uuid, 'ticket_declining', 55,
             jsonb_strip_nulls(jsonb_build_object('last_amount', m.last_amount, 'avg_ticket', m.avg_ticket, 'product', m.product))
      FROM metrics m
      WHERE m.cnt >= 4 AND m.last_amount IS NOT NULL AND m.avg_ticket > 0 AND m.last_amount < m.avg_ticket * 0.7
      UNION ALL
      -- voltou a comprar (contato): última compra nos últimos 7d e a anterior ≥2× a média antes
      SELECT m.contact_id, NULL::uuid, 'customer_reactivated', 35,
             jsonb_strip_nulls(jsonb_build_object('last_amount', m.last_amount, 'product', m.product, 'gap_days', FLOOR(EXTRACT(EPOCH FROM (m.last_transaction_at - prev.occurred_at)) / 86400.0)))
      FROM metrics m
      JOIN LATERAL (
        SELECT t.occurred_at FROM customer_transactions t
        WHERE t.account_id = ${accountId}::uuid AND t.contact_id = m.contact_id
          AND t.occurred_at < m.last_transaction_at AND COALESCE(t.status, '') <> 'canceled'
        ORDER BY t.occurred_at DESC LIMIT 1
      ) prev ON TRUE
      WHERE m.cnt >= 3 AND m.avg > 0 AND m.last_transaction_at >= now() - interval '7 days'
        AND EXTRACT(EPOCH FROM (m.last_transaction_at - prev.occurred_at)) / 86400.0 >= m.avg * 2
      UNION ALL
      -- aprovações paradas (contato): pedido pendente há ≥12h
      SELECT r.contact_id, NULL::uuid, 'approval_required', 40,
             jsonb_build_object('hours_waiting', FLOOR(EXTRACT(EPOCH FROM (now() - MIN(r.created_at))) / 3600.0), 'pending', COUNT(*))
      FROM agent_action_requests r
      WHERE r.account_id = ${accountId}::uuid AND r.status = 'pending' AND r.created_at <= now() - interval '12 hours'
      GROUP BY r.contact_id
    ),
    ups AS (
      INSERT INTO customer_signals
        (account_id, contact_id, deal_id, signal_type, severity, payload, detected_at, updated_at)
      SELECT ${accountId}::uuid, contact_id, deal_id, signal_type, severity, payload, now(), now()
      FROM desired
      ON CONFLICT (account_id, contact_id, signal_type, deal_key) WHERE resolved_at IS NULL
      DO UPDATE SET severity = EXCLUDED.severity, payload = EXCLUDED.payload, updated_at = now()
      RETURNING contact_id
    )
    UPDATE customer_signals s
      SET resolved_at = now(), updated_at = now()
    WHERE s.account_id = ${accountId}::uuid
      AND s.resolved_at IS NULL
      AND s.signal_type IN (${typesList})
      AND NOT EXISTS (
        SELECT 1 FROM desired d
        WHERE d.contact_id = s.contact_id AND d.signal_type = s.signal_type
          AND COALESCE(d.deal_id, '00000000-0000-0000-0000-000000000000'::uuid) = s.deal_key
      );
  `)
}

/** Contas com negócio aberto ou métricas (sweep do worker). */
export async function listOrchestrationAccounts(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT account_id FROM (
      SELECT account_id FROM deals WHERE status = 'open'
      UNION
      SELECT account_id FROM customer_metrics
    ) x
  `)
  return ((res.rows ?? []) as { account_id: string }[]).map((r) => r.account_id)
}

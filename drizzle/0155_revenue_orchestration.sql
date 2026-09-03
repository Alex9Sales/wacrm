-- 🧠 Fase 2 — Revenue Orchestration (Signal → Policy → Action → Approval/Auto → Audit)
--
-- 1) customer_signals ganha escopo por NEGÓCIO (proposal_idle, followup_due,
--    stale_deal, high_intent). `deal_key` é coluna GERADA (deal_id ou uuid zero)
--    pra caber num índice único simples e num ON CONFLICT com colunas.
-- 2) agent_action_requests vira a fila/log GENÉRICA por ação (deal_id, signal_id,
--    decision, policy, executed_at, result, error, attempts).
-- 3) notifications.type: tipos novos (agent_action, approval_required) + os 3
--    que já eram usados no código sem constar no CHECK (task_assigned,
--    flow_notification, contact_opted_out) — inserts deles falhavam em silêncio.

ALTER TABLE customer_signals
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deal_key uuid GENERATED ALWAYS AS (COALESCE(deal_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED;
DROP INDEX IF EXISTS customer_signals_open_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS customer_signals_open_uidx
  ON customer_signals (account_id, contact_id, signal_type, deal_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_signals_open_deal_idx
  ON customer_signals (account_id, deal_id) WHERE resolved_at IS NULL AND deal_id IS NOT NULL;

ALTER TABLE agent_action_requests
  ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES deals(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS deal_key uuid GENERATED ALWAYS AS (COALESCE(deal_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED,
  ADD COLUMN IF NOT EXISTS signal_id uuid,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS policy text,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS error text,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS agent_action_requests_pending_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS agent_action_requests_pending_uidx
  ON agent_action_requests (account_id, contact_id, action_type, deal_key) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS agent_action_requests_deal_idx
  ON agent_action_requests (deal_id, created_at DESC) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_action_requests_signal_idx
  ON agent_action_requests (signal_id, created_at DESC) WHERE signal_id IS NOT NULL;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type = ANY (ARRAY[
  'conversation_assigned', 'sla_alert', 'mention', 'broadcast_halted', 'deal_transferred',
  'deal_ai_suggestion', 'scheduled_message_assigned', 'task_assigned', 'flow_notification',
  'contact_opted_out', 'agent_action', 'approval_required'
]));

COMMENT ON COLUMN agent_action_requests.decision IS 'auto | approve | suggest | blocked — o que a política decidiu';
COMMENT ON COLUMN agent_action_requests.policy IS 'regra que decidiu (ex.: send_followup=auto · risco low · dentro do teto)';
COMMENT ON COLUMN agent_action_requests.result IS 'resultado da execução (ids criados, mensagem enviada…)';

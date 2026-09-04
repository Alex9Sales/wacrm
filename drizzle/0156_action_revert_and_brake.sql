-- 🔙 Reversão/correção das ações da IA + 🛑 freio visível (Fase 2 — segurança
-- para sair do modo aprovação).
--
-- Nem toda ação é reversível do mesmo jeito: mover card, tarefa, follow-up,
-- cadência, desconto e proposta não aceita voltam ao estado anterior; MENSAGEM
-- ENVIADA não desfaz — vira correção pós-ação (marca resultado ruim, pausa a
-- IA na conversa e o humano responde). `revert_state` guarda o que era antes.

ALTER TABLE agent_action_requests
  -- Estado ANTERIOR à execução (o que precisa voltar no desfazer).
  ADD COLUMN IF NOT EXISTS revert_state jsonb,
  -- reverted | corrected | bad_result | ok  (resultado julgado pelo humano)
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS outcome_reason text,
  ADD COLUMN IF NOT EXISTS reverted_at timestamptz,
  ADD COLUMN IF NOT EXISTS reverted_by uuid;

CREATE INDEX IF NOT EXISTS agent_action_requests_outcome_idx
  ON agent_action_requests (account_id, outcome, created_at DESC) WHERE outcome IS NOT NULL;

-- 🧠 Feedback humano estruturado: aprovou / editou / recusou / reverteu, com
-- motivo e uma "impressão digital" do contexto — a base para o Fluxia parar de
-- repetir o mesmo tipo de sugestão ruim (métrica: repetição do mesmo erro).
CREATE TABLE IF NOT EXISTS decision_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  request_id uuid REFERENCES agent_action_requests(id) ON DELETE SET NULL,
  agent_id uuid,
  action_type text NOT NULL,
  signal_type text,
  -- assinatura do contexto (ação + sinal + faixa de severidade) para agrupar
  -- decisões parecidas sem guardar dado do cliente.
  context_fingerprint text NOT NULL,
  -- approved | edited | rejected | reversed | bad_result
  decision text NOT NULL,
  reason_code text,
  reason_text text,
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decision_feedback_pattern_idx
  ON decision_feedback (account_id, context_fingerprint, created_at DESC);
CREATE INDEX IF NOT EXISTS decision_feedback_account_idx
  ON decision_feedback (account_id, created_at DESC);

COMMENT ON TABLE decision_feedback IS 'Toda decisão humana sobre uma ação da IA (aprovou/editou/recusou/reverteu) — base para reduzir a repetição do mesmo erro.';
COMMENT ON COLUMN agent_action_requests.revert_state IS 'Estado anterior à execução; null = ação sem reversão possível (ex.: mensagem enviada).';

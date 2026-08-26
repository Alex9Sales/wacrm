-- 0139 — Funil por agente (multiagente): card criado pela IA nasce no funil
-- do agente. NULL = 1º funil da conta (comportamento antigo).
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS pipeline_id uuid REFERENCES pipelines(id) ON DELETE SET NULL;

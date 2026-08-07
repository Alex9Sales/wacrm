-- Horário de atendimento da IA (Agente IA): a IA só auto-responde conforme o
-- modo, reusando o horário de atendimento da conta. always | inside | outside.
-- (O nó de fluxo "etapa_de_ia" guarda o mesmo modo dentro do JSON do nó, não
-- precisa de coluna.)
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_hours_mode text NOT NULL DEFAULT 'always';

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_hours_mode_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_hours_mode_check
  CHECK (auto_reply_hours_mode IN ('always', 'inside', 'outside'));

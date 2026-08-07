-- Buffer do Agente IA: quanto tempo (s) a IA espera após a ÚLTIMA mensagem do
-- cliente antes de responder (junta a rajada numa resposta só). Antes era só
-- via env AI_REPLY_BUFFER_SECONDS (global); agora é por conta, igual ao campo
-- "Espera antes de responder" do nó de fluxo. 0 = responde na hora.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_buffer_seconds integer NOT NULL DEFAULT 8;

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_auto_reply_buffer_seconds_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_buffer_seconds_check
  CHECK (auto_reply_buffer_seconds >= 0 AND auto_reply_buffer_seconds <= 300);

-- 🔊 Interruptor "Responder por áudio" por agente (pedido do Alex 26/08):
-- separa a CAPACIDADE de responder em voz (este toggle) da PREFERÊNCIA por
-- conversa ([[VOZ]]). OFF → a IA entende áudio normalmente mas responde só em
-- texto, e a preferência de áudio fica inerte. Default true = comportamento
-- atual preservado.
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS audio_replies_enabled boolean NOT NULL DEFAULT true;

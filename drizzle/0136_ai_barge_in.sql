-- 🤫 Barge-in (pedido do Alex 26/08): quando um HUMANO responde na conversa
-- (pelo CRM ou pelo próprio celular), a IA fica quieta por N minutos — sem
-- precisar desligar o botão. 0 = desligado. Depois da janela, ela volta
-- observando (só responde o que ainda precisa de resposta).
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS barge_in_minutes integer NOT NULL DEFAULT 5;

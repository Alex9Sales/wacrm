-- Automação de funil na cadência (pedido do Rafael 26/08): quando ligada, a
-- cadência move o negócio sozinha. Ao inscrever / o lead responder → move pra
-- `contacted_stage_id` (só pra frente, mesmo funil). Ao terminar SEM resposta
-- → marca perdido + fecha a conversa. Opt-in por cadência.
ALTER TABLE cadences
  ADD COLUMN IF NOT EXISTS funnel_automation boolean NOT NULL DEFAULT false;
ALTER TABLE cadences
  ADD COLUMN IF NOT EXISTS contacted_stage_id uuid;

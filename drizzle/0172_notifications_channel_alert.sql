-- 15/09 (GoLink): o Google recusou a senha de app do Gmail às 23:13 de 14/09 e
-- NINGUÉM foi avisado — o canal seguiu verde "conectado". Tipo novo
-- 'channel_alert' pro aviso de canal com problema: o clique leva pra
-- Configurações → Canais ('sla_alert' não leva a lugar nenhum).
--
-- Rodar ANTES do deploy nos DOIS bancos: insert com tipo fora do CHECK falha
-- (lição da 0155).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check" CHECK (
  type = ANY (ARRAY[
    'conversation_assigned'::text, 'sla_alert'::text, 'mention'::text,
    'broadcast_halted'::text, 'deal_transferred'::text, 'deal_ai_suggestion'::text,
    'scheduled_message_assigned'::text, 'task_assigned'::text, 'flow_notification'::text,
    'contact_opted_out'::text, 'agent_action'::text, 'approval_required'::text,
    'channel_alert'::text
  ])
);

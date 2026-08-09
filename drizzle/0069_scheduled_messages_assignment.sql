-- Central de Mensagens Agendadas — responsável + quem atribuiu.
-- assigned_to = responsável pela mensagem (dono do lead); assigned_by = quem
-- atribuiu. Governam a visibilidade por papel (admin tudo / supervisor setor /
-- agente só as dele) e a notificação.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS assigned_to uuid;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS assigned_by uuid;
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_assigned ON scheduled_messages(assigned_to);

-- Backfill: responsável = agente atribuído da conversa (senão o criador);
-- atribuiu = o criador. Só nas linhas ainda sem responsável.
UPDATE scheduled_messages sm
SET assigned_to = COALESCE(c.assigned_agent_id, sm.created_by),
    assigned_by = sm.created_by
FROM conversations c
WHERE c.id = sm.conversation_id
  AND sm.assigned_to IS NULL;

-- Nova notificação: mensagem agendada atribuída a você (deep-link pra conversa).
-- (Inclui deal_ai_suggestion da migração 0066 p/ manter o CHECK completo.)
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check"
  CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text, 'broadcast_halted'::text, 'deal_transferred'::text, 'deal_ai_suggestion'::text, 'scheduled_message_assigned'::text]));

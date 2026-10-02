-- 0205 — deals.conversation_id: ON DELETE SET NULL (02/10/2026).
--
-- A FK nasceu sem regra (NO ACTION). Excluir um CANAL apaga as conversas dele em
-- cascata (conversations.channel_id ON DELETE CASCADE), e qualquer conversa
-- ligada a um card travava a exclusão inteira: "update or delete on table
-- conversations violates foreign key constraint deals_conversation_id_fkey".
-- Uma clínica tentou 6 vezes trocar o WhatsApp e só via "Falha ao remover o
-- canal". A exclusão de conversa avulsa (inbox/actions.ts deleteConversation)
-- já soltava o card antes; agora o banco faz isso em todos os caminhos: o card
-- fica, só perde o vínculo com a conversa apagada.
--
-- Idempotente: rodar em crmfluxia e crmfluxia_prod.

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_conversation_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

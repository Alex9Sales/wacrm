-- ============================================================
-- 🔒 Dedup de mensagem por wamid — mata a duplicação de OUTBOUND.
-- O WAHA ecoa a mensagem fromMe via webhook ALÉM do registro do envio; o dedup
-- app-level (SELECT→skip em inbound.ts) não segura a CORRIDA (echo chega antes do
-- INSERT do envio commitar) → 2 linhas com o MESMO message_id (WhatsApp entrega 1,
-- CRM mostra 2). Afonso 29/08. A trava real é este índice único parcial +
-- .onConflictDoNothing() no insert do inbound.
--
-- ⚠️ Em produção rodar CONCURRENTLY À MÃO (tabela quente, não pode lockar):
--   CREATE UNIQUE INDEX CONCURRENTLY messages_conv_wamid_uidx
--     ON messages (conversation_id, message_id) WHERE message_id IS NOT NULL;
-- (dedupar as linhas existentes ANTES — ver script de dedup). Este arquivo fica
-- só como registro/repetível pra ambientes novos.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS "messages_conv_wamid_uidx"
  ON "messages" ("conversation_id", "message_id")
  WHERE "message_id" IS NOT NULL;

-- Índices de performance pras telas mais quentes (perf 17/08).
--
-- 1) INBOX: listConversations filtra por account_id e ORDENA por
--    last_message_at DESC. Só havia índice de account_id sozinho → o Postgres
--    ordenava ~2k linhas na mão a cada abertura. Composto resolve (e já deixa
--    pronto pra paginação por keyset depois).
-- 2) ABRIR CONVERSA: mensagens são buscadas por conversation_id e ordenadas
--    por created_at DESC (71k+ linhas). Só havia índice de conversation_id →
--    ordenava na mão. Composto (+ id como desempate do cursor) resolve.

CREATE INDEX IF NOT EXISTS idx_conversations_account_last_msg
  ON conversations (account_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at DESC, id DESC);

-- ============================================================
-- Agenda do Google: estado da sincronização automática.
-- Até aqui a importação só rodava quando alguém apertava "Sincronizar" na
-- tela da Agenda (ou no instante da conexão). Com a Zélia (Limpeza com Zelo)
-- oferecendo horário sozinha, a agenda precisa estar fresca sem ninguém
-- clicar — e, quando o Google recusa o token, isso tem que APARECER em vez
-- de falhar em silêncio.
--   last_synced_at  → quando a importação terminou bem (também serve de
--                     carência pra não martelar o Google a cada mensagem)
--   last_sync_error → último erro do Google (NULL quando deu certo)
-- ============================================================

ALTER TABLE calendar_connections
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_sync_error text;

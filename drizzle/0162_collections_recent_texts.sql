-- 🧾 Variação das mensagens de cobrança (item 2 da auditoria de 05/09).
--
-- Para a IA não repetir a mensagem anterior ela precisa VER a anterior. As
-- últimas 3 mensagens de cobrança realmente enviadas a cada devedor ficam
-- aqui, no estado da régua dele, e entram no prompt do próximo toque como
-- "não repita isto".

ALTER TABLE collections_touches
  ADD COLUMN IF NOT EXISTS recent_texts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN collections_touches.recent_texts IS 'Últimas 3 mensagens de cobrança enviadas a este devedor (mais recente primeiro) — a IA recebe para não repetir.';

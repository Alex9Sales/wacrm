-- Automação comentário→DM: amarrar (opcionalmente) a regra a um POST específico
-- (media_id do Instagram). NULL = vale pra qualquer post (comportamento antigo).
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS media_id text;

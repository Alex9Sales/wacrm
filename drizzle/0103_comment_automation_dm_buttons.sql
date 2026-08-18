-- Botões múltiplos no DM da automação de comentário (até 3).
-- Lista de { text, url }. Substitui o par legado dm_button_text/dm_button_url
-- (mantidos pra compat de leitura das regras antigas).
ALTER TABLE "instagram_comment_automations"
  ADD COLUMN IF NOT EXISTS "dm_buttons" jsonb;

-- Migra o botão único existente pro novo formato de lista.
UPDATE "instagram_comment_automations"
   SET "dm_buttons" = jsonb_build_array(
         jsonb_build_object('text', "dm_button_text", 'url', "dm_button_url")
       )
 WHERE "dm_buttons" IS NULL
   AND "dm_button_text" IS NOT NULL
   AND "dm_button_url" IS NOT NULL;

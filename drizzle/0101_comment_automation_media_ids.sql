-- Automação comentário→DM: uma regra pode valer pra VÁRIOS posts (antes era 1).
-- media_ids = lista de media_id do IG. NULL/vazio = qualquer post.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS media_ids text[];

-- Backfill: regras que tinham 1 post (media_id) viram array de 1.
UPDATE instagram_comment_automations
  SET media_ids = ARRAY[media_id]
  WHERE media_id IS NOT NULL
    AND (media_ids IS NULL OR array_length(media_ids, 1) IS NULL);

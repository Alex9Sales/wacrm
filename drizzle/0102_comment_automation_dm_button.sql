-- Botão (estilo ManyChat) no DM da automação de comentário: quando os dois
-- campos vêm preenchidos, o DM é enviado como card com um botão que abre a URL.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS dm_button_text text,
  ADD COLUMN IF NOT EXISTS dm_button_url text;

-- ============================================================
-- Múltiplos anexos no disparo (texto e e-mail): broadcasts.media = jsonb
-- [{url, type, filename}] (até 10). As colunas antigas media_url/media_type/
-- media_filename seguem válidas pra disparos antigos (fallback no worker).
-- No WhatsApp cada anexo vira uma mensagem (legenda no 1º); no e-mail todos
-- vão como ANEXOS de um único e-mail.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS media jsonb;

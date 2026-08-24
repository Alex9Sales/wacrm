-- Rotação de respostas públicas na automação de comentários do IG: até 3
-- variantes alternadas a cada envio (parece humano, evita padrão de spam).
-- public_replies NULL = usa o public_reply legado. Aplicar nos DOIS bancos.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS public_replies jsonb,
  ADD COLUMN IF NOT EXISTS reply_rotation integer NOT NULL DEFAULT 0;

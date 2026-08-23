-- ============================================================
-- E-mail para segmento (newsletter): o motor de Disparos ganha canais de
-- e-mail. `subject` é o assunto quando o canal do disparo é email/gmail
-- (WhatsApp ignora). O destinatário passa a ser contacts.email nesses canais.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS subject text;

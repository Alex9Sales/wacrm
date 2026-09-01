-- Suporte: WhatsApp do cliente + aviso de resolução.
--
-- `whatsapp`: número que o cliente informa ao abrir o chamado (só dígitos,
--   E.164 sem '+'). É por onde a gente responde quando resolve.
-- `resolution_note`: o que foi feito (opcional, escrito por quem resolve) —
--   vai no texto que o cliente recebe.
-- `client_notified_at`: carimbo do aviso enviado. Serve de trava: reabrir e
--   resolver de novo não dispara outra mensagem pro cliente.
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS whatsapp text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_note text;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS client_notified_at timestamptz;

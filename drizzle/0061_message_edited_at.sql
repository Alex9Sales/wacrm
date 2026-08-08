-- Marca quando uma mensagem foi EDITADA (WhatsApp "Editada"), pro CRM mostrar
-- o selo igual ao WhatsApp. Setado tanto no edit inbound (cliente editou) quanto
-- no outbound (nós editamos pelo CRM).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;

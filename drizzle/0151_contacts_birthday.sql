-- Aniversário do contato (pedido do Rafael, 01/09): data pra automação de
-- "feliz aniversário" + carimbo do último parabéns enviado (trava: 1 por ano).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS birthday date;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_birthday_greeting_at timestamptz;

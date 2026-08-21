-- ============================================================
-- PERF (conta do Felipe, 8 canais / 39 usuários / 27k msgs): dois seq scans
-- quentes que saturavam o Postgres compartilhado sob concorrência.
-- ============================================================

-- FIX 1 — Lookup de contato por SUFIXO (últimos 8 dígitos). O findExistingContact
-- roda a CADA inbound e usava `phone LIKE '%suffix'` (wildcard à esquerda NÃO
-- usa índice) → varria os contatos da conta toda vez. Índice de expressão sobre
-- o phone_normalized (dígitos) casa com o novo filtro `right(phone_normalized,8)`.
CREATE INDEX IF NOT EXISTS idx_contacts_account_phone_suffix
  ON contacts (account_id, (right(phone_normalized, 8)));

-- FIX 2 — account_id desnormalizado em messages. As agregações do painel/
-- relatórios filtravam por conversations.account_id (join) + messages.created_at
-- → Seq Scan das 88k mensagens (sem account_id em messages, nenhum índice servia).
-- Com a coluna + índice (account_id, created_at) viram Index Scan.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS account_id uuid;

-- Backfill das mensagens existentes (uma vez).
UPDATE messages m
   SET account_id = c.account_id
  FROM conversations c
 WHERE c.id = m.conversation_id
   AND m.account_id IS NULL;

-- Preenche account_id no INSERT sem tocar nos 18 call sites (bulletproof).
-- Custo: um lookup por PK em conversations por insert (desprezível).
CREATE OR REPLACE FUNCTION messages_fill_account_id() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id IS NULL THEN
    SELECT account_id INTO NEW.account_id
      FROM conversations WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_fill_account_id ON messages;
CREATE TRIGGER trg_messages_fill_account_id
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_fill_account_id();

CREATE INDEX IF NOT EXISTS idx_messages_account_created
  ON messages (account_id, created_at DESC);

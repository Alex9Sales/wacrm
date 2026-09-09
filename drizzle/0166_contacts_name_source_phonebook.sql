-- 📒 Nome do contato: de onde veio + agenda do celular (09/09/2026).
--
-- Caso do Alex: "mudei o nome no CRM e voltou pro nome do WhatsApp" + "quero
-- o contato no CRM do jeito que salvei no celular". Regra de prioridade
-- (lib/contacts/name-rule.ts): nome digitado no CRM > agenda do celular >
-- nome de perfil do WhatsApp (pushName) > telefone. Nada automático troca um
-- nome que alguém digitou no CRM.
--
-- phonebook_entries = espelho da agenda do aparelho por canal:
--   * WAHA (QR): GET /api/contacts/all (entradas com `name` = salvo na agenda);
--   * API oficial em coexistência: webhook `smb_app_state_sync`.
-- channels.phonebook_synced_at marca o opt-in (importou uma vez) + última sync;
-- o worker `phonebook-sync` reconfere a cada 6 h só os canais com esse carimbo.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS name_source text;
COMMENT ON COLUMN contacts.name_source IS 'Origem do nome atual: crm (digitado no CRM) | phonebook (agenda do celular) | whatsapp (nome de perfil / pushName) | null (legado, formulário, API). Prioridade crm > phonebook > whatsapp > telefone.';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS phonebook_synced_at timestamptz;
COMMENT ON COLUMN channels.phonebook_synced_at IS 'Última sincronização da agenda do celular (null = nunca importou → worker não sincroniza).';

CREATE TABLE IF NOT EXISTS phonebook_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text NOT NULL,
  push_name text,
  seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE phonebook_entries IS 'Agenda do celular espelhada por canal (só quem tem nome salvo). phone = dígitos como o WhatsApp identifica o número (pode vir sem o 9º dígito).';

CREATE UNIQUE INDEX IF NOT EXISTS idx_phonebook_entries_channel_phone
  ON phonebook_entries (channel_id, phone);
CREATE INDEX IF NOT EXISTS idx_phonebook_entries_account_suffix
  ON phonebook_entries (account_id, right(phone, 8));

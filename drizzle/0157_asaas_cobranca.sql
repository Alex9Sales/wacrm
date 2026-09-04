-- 🧾 Agente de Cobrança — FASE 1: ler a carteira.
--
-- Liga o Asaas DO CLIENTE (não o nosso, da assinatura Fluxia) e traz a carteira
-- vencida pra dentro do CRM. Nesta fase NADA é enviado: o objetivo é o cliente
-- abrir a tela e reconhecer as cobranças dele, com valor e conta certos.
--
-- Uma conta do CRM pode ter N conexões Asaas (o cliente tem duas: a dele e a do
-- pai, até migrar pra ME). A chave mora criptografada, uma por conexão — é isso
-- que faz as duas contas caberem no mesmo agente e no mesmo número.

CREATE TABLE IF NOT EXISTS asaas_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Nome que o cliente reconhece ("Minha conta", "Conta do pai").
  label text NOT NULL,
  -- Chave de API do Asaas, criptografada (lib/whatsapp/encryption). NUNCA sai
  -- do servidor: as telas e as actions devolvem só os 4 últimos caracteres.
  api_key_enc text NOT NULL,
  -- sandbox | production
  environment text NOT NULL DEFAULT 'sandbox',
  enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_sync_error text,
  last_sync_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asaas_connections_account_label_uidx
  ON asaas_connections (account_id, lower(label));
CREATE INDEX IF NOT EXISTS asaas_connections_account_idx
  ON asaas_connections (account_id, enabled);

CREATE TABLE IF NOT EXISTS asaas_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES asaas_connections(id) ON DELETE CASCADE,
  -- Ids no Asaas (a cobrança e o cliente dela).
  asaas_id text NOT NULL,
  asaas_customer_id text,
  -- Dados do devedor como estão no Asaas (fonte da verdade do cliente).
  customer_name text,
  cpf_cnpj text,
  phone text,
  email text,
  value numeric(12,2) NOT NULL DEFAULT 0,
  due_date date,
  -- Status cru do Asaas (OVERDUE, PENDING, CONFIRMED, RECEIVED…). Guardamos o
  -- que ELES dizem; qual desses conta como "vencido" é configuração do cliente.
  status text NOT NULL,
  billing_type text,
  description text,
  -- Link de pagamento que o Asaas já emitiu — vai junto na mensagem na Fase 2.
  invoice_url text,
  bank_slip_url text,
  installment_number integer,
  -- Contato do CRM com quem a cobrança casou. NULL = pendência visível na tela,
  -- pra alguém resolver na mão. Nunca chutamos.
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- phone | email | code | manual — como casou (auditoria do casamento).
  matched_by text,
  -- `open` = veio na última sincronização bem-sucedida desta conexão. Some da
  -- lista do Asaas (pagou/apagaram) → open=false + closed_at. Não apagamos a
  -- linha: o histórico do que já foi cobrado precisa sobreviver.
  open boolean NOT NULL DEFAULT true,
  closed_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asaas_charges_account_asaas_uidx
  ON asaas_charges (account_id, asaas_id);
CREATE INDEX IF NOT EXISTS asaas_charges_wallet_idx
  ON asaas_charges (account_id, open, due_date) WHERE open;
CREATE INDEX IF NOT EXISTS asaas_charges_contact_idx
  ON asaas_charges (account_id, contact_id);
CREATE INDEX IF NOT EXISTS asaas_charges_connection_idx
  ON asaas_charges (connection_id, open);

COMMENT ON TABLE asaas_connections IS 'Conexões Asaas DO CLIENTE (N por conta do CRM) — chave criptografada, uma por conexão.';
COMMENT ON TABLE asaas_charges IS 'Carteira do cliente espelhada do Asaas. Fase 1 só lê; nada é enviado a partir daqui.';
COMMENT ON COLUMN asaas_charges.contact_id IS 'NULL = não casou com contato do CRM; vira pendência na tela em vez de chute.';

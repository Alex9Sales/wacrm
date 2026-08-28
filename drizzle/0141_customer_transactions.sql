-- 0141 — Customer Data Layer (Fase 1): razão comercial NATIVO.
--
-- FRONTEIRA (cristalina, de propósito):
--   customer_transactions = LEDGER COMERCIAL IMUTÁVEL (fatos consumados:
--     compra, serviço, agendamento, renovação, proposta aceita, assinatura).
--   deals                 = oportunidades MUTÁVEIS do funil (em andamento).
-- Um deal ganho PODE gerar uma transação (deal_id), mas uma transação NÃO
-- precisa vir de um deal — assim dá pra importar anos de histórico de vendas
-- SEM criar milhares de deals artificiais no funil.
--
-- IDEMPOTÊNCIA: só linhas COM external_id são deduplicadas (dados nativos têm
-- external_id NULL e nunca conflitam). external_id = id no sistema de origem;
-- source_updated_at = quando a origem alterou o registro (sync incremental).

CREATE TABLE IF NOT EXISTS customer_transactions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id)     ON DELETE CASCADE,
  deal_id           uuid REFERENCES deals(id)                 ON DELETE SET NULL,
  type              text NOT NULL DEFAULT 'purchase',   -- purchase|service|appointment|renewal|proposal|subscription
  source            text NOT NULL DEFAULT 'native',     -- native|import|erp:<nome>|...
  external_id       text,                               -- id na origem (trava de sync)
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  amount            numeric(12,2) NOT NULL DEFAULT 0,
  currency          text NOT NULL DEFAULT 'BRL',
  payment_method    text,                               -- dinheiro|pix|debito|credito_avista|credito_parcelado|...
  status            text NOT NULL DEFAULT 'completed',  -- completed|canceled|pending|refunded
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb, -- dados por nicho (produto, marca, qtd, etc.)
  source_updated_at timestamptz,                        -- última alteração NA ORIGEM
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE customer_transactions IS
  'Immutable commercial ledger (facts: purchase/service/appointment/renewal/proposal/subscription). deals = mutable pipeline opportunities. A won deal MAY produce a transaction (deal_id); a transaction need not come from a deal.';

-- Trava de sync: dedup só do que tem origem externa.
CREATE UNIQUE INDEX IF NOT EXISTS customer_transactions_source_extid_uidx
  ON customer_transactions (account_id, source, external_id)
  WHERE external_id IS NOT NULL;

-- Query principal: histórico de um contato, mais novo primeiro.
CREATE INDEX IF NOT EXISTS customer_transactions_contact_idx
  ON customer_transactions (account_id, contact_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS customer_transactions_account_occurred_idx
  ON customer_transactions (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS customer_transactions_deal_idx
  ON customer_transactions (deal_id);

-- Itens da transação (opcional; quando o nicho precisa de linhas: gás completo =
-- vasilhame + recarga; oficina = serviço + peças; etc.). Cabeçalho já tem amount.
CREATE TABLE IF NOT EXISTS customer_transaction_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES customer_transactions(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES organization(id)          ON DELETE CASCADE,
  product_ref    text,                                -- sku/id do produto na origem ou no Fluxia
  name           text NOT NULL,
  quantity       numeric(12,3) NOT NULL DEFAULT 1,
  unit_amount    numeric(12,2) NOT NULL DEFAULT 0,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_transaction_items_txn_idx
  ON customer_transaction_items (transaction_id);
CREATE INDEX IF NOT EXISTS customer_transaction_items_account_idx
  ON customer_transaction_items (account_id);

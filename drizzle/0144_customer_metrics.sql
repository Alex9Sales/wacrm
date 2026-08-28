-- 0144 — Customer Data Layer (Fase 3): customer_metrics.
-- CACHE recomputável a partir de customer_transactions (nunca é fonte de
-- verdade). 1 linha por (conta, contato). Guarda as métricas ESTÁVEIS; as
-- que dependem do "agora" (dias sem comprar, atraso) o digest calcula na hora
-- a partir de last_transaction_at + average_repurchase_days.
CREATE TABLE IF NOT EXISTS customer_metrics (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES contacts(id)     ON DELETE CASCADE,
  transaction_count        integer NOT NULL DEFAULT 0,        -- compras válidas (não canceladas)
  total_revenue            numeric(14,2) NOT NULL DEFAULT 0,
  average_ticket           numeric(12,2) NOT NULL DEFAULT 0,
  first_transaction_at     timestamptz,
  last_transaction_at      timestamptz,
  last_transaction_amount  numeric(12,2),
  average_repurchase_days  numeric(10,2),                     -- média de dias entre compras
  preferred_product        text,                              -- produto mais comprado (metadata.product)
  preferred_payment_method text,
  next_expected_at         timestamptz,                       -- last + média (previsão de recompra)
  churn_score              integer,                           -- reservado (calculado depois)
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_metrics_account_contact_uidx
  ON customer_metrics (account_id, contact_id);
CREATE INDEX IF NOT EXISTS customer_metrics_next_expected_idx
  ON customer_metrics (account_id, next_expected_at);

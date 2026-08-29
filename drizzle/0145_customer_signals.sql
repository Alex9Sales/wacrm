-- ============================================================
-- 📡 Customer Data Layer (Fase 7) — customer_signals
-- Estado ABERTO por cliente, derivado de customer_metrics + o "agora":
-- recompra_due (chegou a hora), recompra_overdue (atrasou), inactive (sumiu),
-- high_value (cliente valioso). Alimenta a lista "chamar de volta", o motor
-- de recompra e (futuro) a autonomia. Delimitação:
--   deal_events   = log imutável do que aconteceu
--   customer_signals = estado aberto pra AÇÃO (este)
--   notifications = entrega
-- Recomputável: o detector reabre/atualiza/resolve conforme as métricas mudam.
-- ============================================================

CREATE TABLE IF NOT EXISTS "customer_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "contact_id" uuid NOT NULL,
  -- repurchase_due | repurchase_overdue | inactive | high_value
  "signal_type" text NOT NULL,
  -- 0..100 (quanto mais alto, mais urgente/relevante)
  "severity" integer DEFAULT 0 NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "detected_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz,
  "resolved_at" timestamptz,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "customer_signals_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "customer_signals_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE cascade
);

-- Um sinal ABERTO por (conta, contato, tipo) — o detector faz upsert nesse alvo.
CREATE UNIQUE INDEX IF NOT EXISTS "customer_signals_open_uidx"
  ON "customer_signals" ("account_id", "contact_id", "signal_type")
  WHERE "resolved_at" IS NULL;

-- Lista "quem chamar de volta": abertos da conta, por tipo, mais urgentes 1º.
CREATE INDEX IF NOT EXISTS "customer_signals_open_list_idx"
  ON "customer_signals" ("account_id", "signal_type", "severity" DESC)
  WHERE "resolved_at" IS NULL;

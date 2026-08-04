-- Histórico do lead no funil (timeline estilo RD Station): cada evento do
-- negócio — criação, mudança de etapa, marcado como venda/perda, e anotações
-- manuais — vira uma linha aqui, exibida na aba "Histórico" do detalhe.
CREATE TABLE IF NOT EXISTS "deal_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "actor_user_id" uuid,
  "type" text NOT NULL,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_deal_events_deal" ON "deal_events" ("deal_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_deal_events_account" ON "deal_events" ("account_id");

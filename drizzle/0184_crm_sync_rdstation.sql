-- 0184 — Espelho com CRM externo (RD Station CRM) (18/09/2026).
-- Conta que usa o RD CRM como base da operação e o FluxiaCRM como "backend"
-- (a IA atende e move os cards): o que muda no card daqui vai pro negócio de
-- lá, e o que o time move lá volta pra cá (webhook).
--
-- Fila por GATILHO no banco: QUALQUER caminho que mexe no card (tela, IA,
-- cadência, automação, API, SQL) entra na fila — nenhum ponto do código
-- precisa lembrar de avisar. Só enfileira em conta com integração ligada.

CREATE TABLE IF NOT EXISTS "crm_integrations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,                        -- 'rdstation_crm'
  "token_encrypted" text NOT NULL,                 -- token da instância (é por USUÁRIO no RD)
  "webhook_secret" text NOT NULL,                  -- segredo da URL do webhook de volta
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,     -- { defaultOwnerExternalId, ... }
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crm_integrations_account_provider_key" UNIQUE ("account_id", "provider"),
  CONSTRAINT "crm_integrations_webhook_secret_key" UNIQUE ("webhook_secret")
);

CREATE TABLE IF NOT EXISTS "crm_deal_links" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  -- Último estado CONHECIDO do negócio de lá (anti-eco nos dois sentidos).
  "external_stage_id" text,
  "external_status" text,                          -- 'open' | 'won' | 'lost'
  "synced_at" timestamptz,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crm_deal_links_provider_deal_key" UNIQUE ("provider", "deal_id"),
  CONSTRAINT "crm_deal_links_provider_external_key" UNIQUE ("provider", "account_id", "external_id")
);

CREATE TABLE IF NOT EXISTS "crm_sync_outbox" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL,
  "deal_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text
);
CREATE INDEX IF NOT EXISTS "idx_crm_sync_outbox_pending" ON "crm_sync_outbox" ("created_at") WHERE "processed_at" IS NULL;

CREATE OR REPLACE FUNCTION crm_sync_enqueue() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM crm_integrations i WHERE i.account_id = NEW.account_id AND i.enabled
  ) THEN
    INSERT INTO crm_sync_outbox (account_id, deal_id) VALUES (NEW.account_id, NEW.id);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crm_sync_enqueue_ins ON "deals";
CREATE TRIGGER trg_crm_sync_enqueue_ins
AFTER INSERT ON "deals"
FOR EACH ROW EXECUTE FUNCTION crm_sync_enqueue();

DROP TRIGGER IF EXISTS trg_crm_sync_enqueue_upd ON "deals";
CREATE TRIGGER trg_crm_sync_enqueue_upd
AFTER UPDATE OF stage_id, pipeline_id, status, lost_reason, assigned_to ON "deals"
FOR EACH ROW
WHEN (
  OLD.stage_id IS DISTINCT FROM NEW.stage_id
  OR OLD.pipeline_id IS DISTINCT FROM NEW.pipeline_id
  OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.lost_reason IS DISTINCT FROM NEW.lost_reason
  OR OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
)
EXECUTE FUNCTION crm_sync_enqueue();

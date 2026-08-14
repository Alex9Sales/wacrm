-- Fase 2 — o agente APONTA para uma credencial (ai_credentials) em vez de ter a
-- chave embutida. NULLABLE: agente sem credential_id continua usando a chave
-- embutida (ai_configs.api_key) — zero quebra nos agentes atuais. Ao remover a
-- credencial, o vínculo vira NULL (o runtime cai no fallback da chave embutida).
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "credential_id" uuid;
DO $$ BEGIN
  ALTER TABLE "ai_configs"
    ADD CONSTRAINT "ai_configs_credential_id_fkey"
    FOREIGN KEY ("credential_id") REFERENCES "ai_credentials"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
CREATE INDEX IF NOT EXISTS "ai_configs_credential_idx" ON "ai_configs" USING btree ("credential_id");

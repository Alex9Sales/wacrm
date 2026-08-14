-- Chaves de API reutilizáveis (credenciais) — Fase 1 da reforma de agentes.
-- Cada agente vai APONTAR pra uma credencial (Fase 2) em vez de ter a chave
-- embutida. Provedores: openai, anthropic, gemini (o adapter do gemini entra
-- na Fase 3; aqui o provider já é aceito na tabela p/ frente-compatibilidade).
-- account-scoped. api_key guardada criptografada (mesmo esquema do ai_configs).
CREATE TABLE IF NOT EXISTS "ai_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "created_by" uuid,
  "provider" text NOT NULL,
  "label" text NOT NULL,
  "api_key" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_credentials_provider_check" CHECK (provider = ANY (ARRAY['openai'::text,'anthropic'::text,'gemini'::text])),
  CONSTRAINT "ai_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_credentials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "ai_credentials_account_idx" ON "ai_credentials" USING btree ("account_id","created_at");

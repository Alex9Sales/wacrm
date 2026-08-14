-- Suporte (14/08) — chamados abertos pelo cliente na tela /suporte.
-- O cliente descreve a dúvida/problema, cola o print do erro e o chamado
-- (1) fica registrado aqui (setor Suporte no /admin) e (2) dispara um alerta
-- no WhatsApp da Fluxia com o print + contexto. account-scoped por org.
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "created_by" uuid,
  -- 'question' (dúvida) | 'config' (ajuda com configuração) | 'problem' (bug)
  "type" text DEFAULT 'problem' NOT NULL,
  "subject" text NOT NULL,
  "description" text,
  -- URLs públicas dos prints anexados (MinIO/bucket 'media').
  "screenshot_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- Contexto coletado automático: {url, userAgent, appVersion, orgName, userName, userEmail}.
  "context" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- 'open' | 'in_progress' | 'resolved'
  "status" text DEFAULT 'open' NOT NULL,
  -- Quando o alerta de WhatsApp foi disparado (null = não saiu / falhou).
  "alerted_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "support_tickets_type_check" CHECK (type = ANY (ARRAY['question'::text,'config'::text,'problem'::text])),
  CONSTRAINT "support_tickets_status_check" CHECK (status = ANY (ARRAY['open'::text,'in_progress'::text,'resolved'::text])),
  CONSTRAINT "support_tickets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "support_tickets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "support_tickets_account_idx" ON "support_tickets" USING btree ("account_id","created_at");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets" USING btree ("status","created_at");

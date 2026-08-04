-- Questionários (perguntas de qualificação) e E-mails (registro/anexo de e-mails
-- trocados com o lead) do negócio no funil, estilo RD.
CREATE TABLE IF NOT EXISTS "deal_questions" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "question" text NOT NULL,
  "answer" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_deal_questions_deal" ON "deal_questions" ("deal_id");

CREATE TABLE IF NOT EXISTS "deal_emails" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "subject" text NOT NULL,
  "body" text,
  "actor_user_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_deal_emails_deal" ON "deal_emails" ("deal_id");

-- Fase K4 — Aprender da conversa com APROVAÇÃO. A IA lê uma conversa e PROPÕE
-- pares pergunta→resposta reutilizáveis; nada entra na base sem um humano
-- aprovar (princípio: IA observa → sugere → humano confirma). Fila account-scoped.
CREATE TABLE IF NOT EXISTS "ai_knowledge_approvals" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "account_id" uuid NOT NULL,
  "knowledge_base_id" uuid,
  "conversation_id" uuid,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "reviewed_by" uuid,
  "reviewed_at" timestamptz,
  CONSTRAINT "ai_knowledge_approvals_status_check" CHECK (status = ANY (ARRAY['pending'::text,'approved'::text,'rejected'::text])),
  CONSTRAINT "ai_knowledge_approvals_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_knowledge_approvals_kb_fkey" FOREIGN KEY ("knowledge_base_id") REFERENCES "ai_knowledge_bases"("id") ON DELETE SET NULL,
  CONSTRAINT "ai_knowledge_approvals_conversation_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "ai_knowledge_approvals_account_status_idx" ON "ai_knowledge_approvals" USING btree ("account_id","status","created_at");

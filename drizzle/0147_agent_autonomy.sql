-- ============================================================
-- 🎛️ CDL Fase 8 — Autonomia governada.
-- (1) Política POR AÇÃO por agente (ai_configs.autonomy jsonb):
--     { "reactivation": "suggest" | "approve" | "auto", ... }.
--     suggest = aparece na lista (humano inicia); approve = a IA rascunha e vai
--     pra FILA (humano aprova/edita/recusa); auto = a IA age sozinha.
-- (2) Fila de aprovação: ações PENDENTES que a IA propôs e aguardam o humano.
-- ============================================================

ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "autonomy" jsonb DEFAULT '{}'::jsonb NOT NULL;

CREATE TABLE IF NOT EXISTS "agent_action_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "agent_id" uuid,
  "contact_id" uuid NOT NULL,
  "conversation_id" uuid,
  -- reactivation (v1) | discount | move_card | ... (extensível)
  "action_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- Mensagem que a IA propôs (editável na aprovação).
  "suggested_text" text,
  -- Log da decisão: POR QUE a IA propôs (ex.: "recompra atrasada há 45 dias").
  "reason" text,
  -- pending | sent | rejected | expired
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "resolved_at" timestamptz,
  "resolved_by" uuid,
  CONSTRAINT "agent_action_requests_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "agent_action_requests_contact_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE cascade
);

-- Uma pendência por (conta, contato, tipo) — o gerador faz upsert nisso.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_action_requests_pending_uidx"
  ON "agent_action_requests" ("account_id", "contact_id", "action_type")
  WHERE "status" = 'pending';

-- Fila da conta: pendentes, mais recentes/urgentes primeiro.
CREATE INDEX IF NOT EXISTS "agent_action_requests_queue_idx"
  ON "agent_action_requests" ("account_id", "status", "created_at" DESC);

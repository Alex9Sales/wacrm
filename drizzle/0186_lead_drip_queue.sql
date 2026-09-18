-- ============================================================
-- Fila de entrada GOTEJADA de leads (ex.: Zelo 18/09 — 41 leads parados no
-- RD, 10 por dia): cada linha é um `ingestLead` que roda SÓ em `run_after`.
-- Nada é criado antes da hora (contato, card, conversa) — senão a caixa de
-- entrada ganha dezenas de conversas vazias no topo dias antes do envio.
-- O worker (`lead-drip-worker`, tick 2 min) processa as vencidas.
-- ============================================================

CREATE TABLE IF NOT EXISTS "lead_drip_queue" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  -- Lote/origem legível (ex.: "Zelo · leads parados do RD · 18/09").
  "label" text NOT NULL,
  -- IngestLeadInput (sem o usuário de auditoria — resolvido na hora).
  "input" jsonb NOT NULL,
  "run_after" timestamptz NOT NULL,
  -- pending | processing | done | failed | cancelled
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "last_error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "processed_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_lead_drip_queue_due"
  ON "lead_drip_queue" ("run_after")
  WHERE "status" = 'pending';

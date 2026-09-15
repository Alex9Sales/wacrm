-- 15/09 (GoLink, revisão dos disparos):
-- 1) broadcast_events: rastro PERSISTENTE de quem criou/pausou/retomou/
--    cancelou/arquivou/excluiu/tirou da fila. O log do container some a cada
--    deploy — foi exatamente a pergunta sem resposta do "dia do cliente".
--    Sem FK para broadcasts: o evento de exclusão sobrevive à linha apagada.
-- 2) broadcasts.allow_repeats: quem criou marcou "enviar também pra quem já
--    recebeu esta mensagem hoje". O worker confere na hora do envio e pula
--    quem já recebeu por OUTRO disparo — a menos que isto esteja ligado.
--    API v1 grava true (integrações não mudam de comportamento).
-- Aditiva; rodar nos DOIS bancos ANTES do deploy.
CREATE TABLE IF NOT EXISTS "broadcast_events" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "broadcast_id" uuid NOT NULL,
  "user_id" uuid,
  "role" text,
  "action" text NOT NULL,
  "previous_status" text,
  "channel_id" uuid,
  "sent_count" integer,
  "extra" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_broadcast_events_broadcast"
  ON "broadcast_events" ("account_id", "broadcast_id", "created_at");

ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "allow_repeats" boolean NOT NULL DEFAULT false;

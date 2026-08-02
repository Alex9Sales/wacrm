-- Fluxos: timeout-como-caminho (Fase 2 Etapa 5). Quando um nó que espera
-- resposta (send_buttons/send_list/collect_input) tem um `timeout`, o run
-- fica com um prazo em timeout_at; o scheduler encaminha o run pelo caminho
-- de timeout se nenhuma resposta limpar o prazo antes.
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "timeout_at" timestamptz;

-- Busca dos runs vencidos pelo worker (só ativos aguardando resposta).
CREATE INDEX IF NOT EXISTS "idx_flow_runs_timeout"
  ON "flow_runs" USING btree ("timeout_at")
  WHERE ((status = 'active') AND (timeout_at IS NOT NULL));

-- Fase 2 dos Fluxos (drip), Etapa 1: nó `delay` + agendamento persistente.
-- Um run que chega num nó delay DORME (status='sleeping') com resume_at = a
-- hora de acordar; o worker agendador (drip) resume o run quando vence. Assim
-- um delay de dias sobrevive a restart do servidor.

-- Quando acordar.
ALTER TABLE "flow_runs" ADD COLUMN IF NOT EXISTS "resume_at" timestamptz;

-- Permitir o novo status 'sleeping'.
ALTER TABLE "flow_runs" DROP CONSTRAINT IF EXISTS "flow_runs_status_check";
ALTER TABLE "flow_runs" ADD CONSTRAINT "flow_runs_status_check"
  CHECK (status = ANY (ARRAY['active'::text, 'sleeping'::text, 'completed'::text, 'handed_off'::text, 'timed_out'::text, 'paused_by_agent'::text, 'failed'::text]));

-- Permitir o novo node_type 'delay'.
ALTER TABLE "flow_nodes" DROP CONSTRAINT IF EXISTS "flow_nodes_node_type_check";
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_node_type_check"
  CHECK (node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'delay'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text]));

-- "1 run vivo por contato" passa a cobrir active E sleeping (um contato em
-- drip não pode iniciar um 2º fluxo). Recria o índice parcial único.
DROP INDEX IF EXISTS "idx_one_active_run_per_contact";
CREATE UNIQUE INDEX "idx_one_active_run_per_contact"
  ON "flow_runs" USING btree ("account_id" uuid_ops, "contact_id" uuid_ops)
  WHERE (status = ANY (ARRAY['active'::text, 'sleeping'::text]));

-- Lookup dos runs vencidos pro worker.
CREATE INDEX IF NOT EXISTS "idx_flow_runs_sleeping_resume"
  ON "flow_runs" USING btree ("resume_at" timestamptz_ops)
  WHERE (status = 'sleeping'::text);

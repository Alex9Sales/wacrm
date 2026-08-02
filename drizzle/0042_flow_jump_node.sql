-- Fase 2 dos Fluxos, Etapa 3: nó `jump` (pular/voltar pra outro nó). Permite
-- loops (ex.: "esperar 30 dias → voltar pro início"). Anti-loop é no motor
-- (limite de jumps por run), não no schema.
ALTER TABLE "flow_nodes" DROP CONSTRAINT IF EXISTS "flow_nodes_node_type_check";
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_node_type_check"
  CHECK (node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'delay'::text, 'jump'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text]));

-- Fluxos: nó `ai` (Etapa de IA) — entrega a conversa pro agente de IA da
-- conta (prompt + RAG), com buffer humanizado e loop até transferir.
ALTER TABLE "flow_nodes" DROP CONSTRAINT IF EXISTS "flow_nodes_node_type_check";
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_node_type_check"
  CHECK (node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'delay'::text, 'jump'::text, 'randomizer'::text, 'action'::text, 'ai'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text]));

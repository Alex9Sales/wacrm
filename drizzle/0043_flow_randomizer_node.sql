-- Fluxos: nó `randomizer` (split A/B por peso, tipo o "Randomizador" do
-- ManyChat). Divide o run aleatoriamente entre N ramos ponderados — bom pra
-- testar mensagens.
ALTER TABLE "flow_nodes" DROP CONSTRAINT IF EXISTS "flow_nodes_node_type_check";
ALTER TABLE "flow_nodes" ADD CONSTRAINT "flow_nodes_node_type_check"
  CHECK (node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'delay'::text, 'jump'::text, 'randomizer'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text]));

-- Fase 2 dos Fluxos, Etapa 2: trigger `tag_added`. Um fluxo pode ser iniciado
-- quando uma etiqueta específica é ADICIONADA a um contato (UI/inbox/contatos,
-- API pública, automação, ou nó set_tag) — evento interno, não mensagem do
-- cliente. Roda na conversa mais recente do contato (respeitando o canal do
-- fluxo, se setado).
ALTER TABLE "flows" DROP CONSTRAINT IF EXISTS "flows_trigger_type_check";
ALTER TABLE "flows" ADD CONSTRAINT "flows_trigger_type_check"
  CHECK (trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'tag_added'::text, 'manual'::text]));

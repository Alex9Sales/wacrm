-- Fase 2 (unificação ManyChat): a automação de comentário do Instagram pode,
-- depois de mandar o DM, INICIAR um Fluxo (sequência visual com botões/etapas)
-- pro contato. Ponte entre comentário→DM (que já funciona) e o construtor Fluxos.
ALTER TABLE "instagram_comment_automations"
  ADD COLUMN IF NOT EXISTS "start_flow_id" uuid;

-- FK opcional: se o fluxo for excluído, só zera o vínculo (não apaga a automação).
DO $$ BEGIN
  ALTER TABLE "instagram_comment_automations"
    ADD CONSTRAINT "ig_comment_automations_start_flow_id_fkey"
    FOREIGN KEY ("start_flow_id") REFERENCES "flows"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

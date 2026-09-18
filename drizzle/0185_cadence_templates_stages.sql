-- ============================================================
-- Cadência com MODELO aprovado, card andando por etapa e perda com espera.
--
-- Zelo 18/09 (playbook da Zélia + funil do Jordan): lead que nunca respondeu a
-- abertura segue a "Cadência pré-vendas" — 1ª..5ª tentativa → Definição →
-- perdido "Não respondeu" 72 h depois. No número OFICIAL, fora da janela de
-- 24 h, só modelo aprovado chega: o degrau leva o modelo além do texto.
--
--   cadence_steps.template_*     modelo usado quando o canal exige (Meta fora
--                                da janela); senão sai o texto do degrau.
--   cadence_steps.move_to_stage_id  ao ENVIAR o degrau, o card anda pra etapa
--                                (só pra frente, só no funil dele).
--   cadences.lose_after_hours    terminou sem resposta → espera N horas antes
--                                de marcar perdido (null/0 = na hora, como antes).
--   cadences.lost_reason         motivo da perda automática (null = o antigo
--                                "Não respondeu à cadência").
--   cadence_enrollments.lose_at  quando a perda vence (inscrição segue ATIVA
--                                até lá — resposta do lead ainda pausa).
--   scheduled_messages.template_* o degrau agendado carrega o modelo; o worker
--                                decide no ENVIO (janela aberta = texto).
-- ============================================================

ALTER TABLE "cadence_steps" ADD COLUMN IF NOT EXISTS "template_name" text;
ALTER TABLE "cadence_steps" ADD COLUMN IF NOT EXISTS "template_language" text;
ALTER TABLE "cadence_steps" ADD COLUMN IF NOT EXISTS "template_params" jsonb;
ALTER TABLE "cadence_steps" ADD COLUMN IF NOT EXISTS "move_to_stage_id" uuid
  REFERENCES "pipeline_stages"("id") ON DELETE SET NULL;

ALTER TABLE "cadences" ADD COLUMN IF NOT EXISTS "lose_after_hours" integer;
ALTER TABLE "cadences" ADD COLUMN IF NOT EXISTS "lost_reason" text;

ALTER TABLE "cadence_enrollments" ADD COLUMN IF NOT EXISTS "lose_at" timestamptz;
CREATE INDEX IF NOT EXISTS "idx_cadence_enroll_lose_at"
  ON "cadence_enrollments" ("lose_at")
  WHERE "status" = 'active' AND "lose_at" IS NOT NULL;

ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "template_name" text;
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "template_language" text;
ALTER TABLE "scheduled_messages" ADD COLUMN IF NOT EXISTS "template_params" jsonb;

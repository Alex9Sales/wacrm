-- Ferramentas do agente (Fase A) — conjunto de ações que a IA pode fazer no CRM.
-- Backfill preserva o comportamento atual: skip_reply/tag/handoff eram "sempre
-- ligados"; resolve+move_card vinham de auto_close_enabled; schedule de
-- auto_schedule_enabled. (As colunas antigas ficam por ora; runtime lê `tools`.)
ALTER TABLE "ai_configs"
  ADD COLUMN IF NOT EXISTS "tools" jsonb NOT NULL DEFAULT '["skip_reply","tag","handoff"]'::jsonb;
UPDATE "ai_configs" SET "tools" = (
  '["skip_reply","tag","handoff"]'::jsonb
  || (CASE WHEN auto_close_enabled THEN '["resolve","move_card"]'::jsonb ELSE '[]'::jsonb END)
  || (CASE WHEN auto_schedule_enabled THEN '["schedule"]'::jsonb ELSE '[]'::jsonb END)
);

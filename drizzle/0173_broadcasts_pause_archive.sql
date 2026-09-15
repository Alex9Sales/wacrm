-- 15/09 (GoLink): o "dia do cliente" foi pausado, cancelado e EXCLUÍDO sem
-- deixar rastro de quem fez — e excluir apagava o histórico de quem já tinha
-- recebido. Agora:
--   paused_by / paused_at / pause_reason — quem pausou (ou "automático":
--     número bloqueado, sessão caiu) pra tela mostrar "Pausado por Vitor às 10:24";
--   archived_at / archived_by — "Excluir" de disparo que já enviou vira
--     arquivar (some da lista, histórico fica).
-- Aditiva; rodar nos DOIS bancos ANTES do deploy (select * de broadcasts).
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "paused_by" uuid;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "archived_at" timestamptz;
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "archived_by" uuid;

CREATE INDEX IF NOT EXISTS "idx_broadcasts_account_active"
  ON "broadcasts" ("account_id", "created_at" DESC)
  WHERE "archived_at" IS NULL;

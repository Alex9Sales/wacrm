-- CSAT: comentário livre do cliente + estado de "aguardando comentário".
ALTER TABLE "csat_responses" ADD COLUMN IF NOT EXISTS "comment" text;
-- Quando setado, a próxima mensagem do cliente vira o comentário desta resposta.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "csat_comment_pending" uuid;

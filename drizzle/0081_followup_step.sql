-- Follow-up em ESCADA (v2): rastreia em qual degrau (step) a conversa está no
-- episódio de silêncio atual. Incrementa a cada follow-up enviado; volta a valer
-- do degrau 0 quando o cliente responde (episódio reinicia — calculado, não
-- resetado aqui). Idempotente.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "follow_up_step" integer DEFAULT 0 NOT NULL;

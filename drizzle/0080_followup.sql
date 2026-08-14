-- Follow-up inteligente (reengajamento proativo). Config por agente em
-- ai_configs.follow_up (jsonb: enabled, delayMinutes, instructions, armedAt) e
-- marca-d'água por conversa (last_follow_up_at) pra garantir 1 follow-up por
-- silêncio (só volta a disparar depois que o cliente responder). Idempotente.
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "follow_up" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_follow_up_at" timestamptz;

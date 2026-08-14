-- Fase 3 — Gemini. O agente pode ter provider='gemini' (via credencial Gemini).
-- Relaxa o CHECK de provider em ai_configs pra aceitar 'gemini'. (ai_credentials
-- já aceitava gemini desde a 0084.)
ALTER TABLE "ai_configs" DROP CONSTRAINT IF EXISTS "ai_configs_provider_check";
ALTER TABLE "ai_configs" ADD CONSTRAINT "ai_configs_provider_check"
  CHECK (provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text]));

-- 0142 — "IA recua quando o humano entra na conversa".
-- Setado quando o atendente DIGITA no inbox (presença ativa). A auto-resposta
-- pula enquanto human_present_until > now(), mesmo sem o humano ter enviado nada
-- ainda — evita a IA atropelar quem está começando a responder.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS human_present_until timestamptz;

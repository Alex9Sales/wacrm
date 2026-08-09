-- IA para Negociações v2 — Fase 3 (proativo).
-- Toggle por conta: a IA analisa sozinha o negócio quando chega mensagem do
-- cliente (com buffer/cooldown no worker) e cria sugestões pendentes. OPT-IN,
-- default OFF (roda sozinha e gasta token, então nunca liga sem escolha).
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS deal_suggestions_proactive boolean NOT NULL DEFAULT false;

-- Nova notificação: "a IA deixou sugestões no negócio X" (deep-link pro deal).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check"
  CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text, 'broadcast_halted'::text, 'deal_transferred'::text, 'deal_ai_suggestion'::text]));

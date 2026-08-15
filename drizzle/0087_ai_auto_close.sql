-- Encerramento inteligente (opt-in por agente): quando o cliente não tem mais
-- interesse / o atendimento acaba, a IA se despede, RESOLVE a conversa e MOVE o
-- card do funil pra etapa adequada (ela escolhe pelo nome). Default OFF.
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "auto_close_enabled" boolean DEFAULT false NOT NULL;

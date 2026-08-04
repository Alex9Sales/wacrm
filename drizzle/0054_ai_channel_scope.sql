-- Canais onde a IA responde automaticamente (multi-seleção). Vazio = todos os
-- canais (compatibilidade). Preenchido = só nesses canais.
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "auto_reply_channel_ids" uuid[] NOT NULL DEFAULT '{}';

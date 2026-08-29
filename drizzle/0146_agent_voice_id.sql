-- Voz do áudio da IA por agente (ElevenLabs). NULL = OpenAI 'nova' (padrão).
-- A CHAVE do ElevenLabs mora em voice_settings.elevenlabs_api_key (por conta,
-- setada em Agentes de voz) — reusada aqui. O voice_provider fica implícito:
-- se o agente tem voice_id E a conta tem chave ElevenLabs → ElevenLabs; senão OpenAI.
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "voice_id" text;

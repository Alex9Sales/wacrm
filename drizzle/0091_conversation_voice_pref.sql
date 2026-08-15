-- Preferência de voz do cliente na conversa (ferramenta voice_pref): 'audio' | 'text'.
-- A IA registra quando o cliente diz que prefere áudio ou texto; enviesa o formato.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "voice_preference" text;

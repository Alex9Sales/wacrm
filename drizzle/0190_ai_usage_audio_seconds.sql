-- Medidor de custo por fonte (23/09, Alex): "esse medidor de custo por fonte
-- — cobrança, transcrição, imagem — a gente coloca lá no painel do custo da
-- LLM, num bloquinho separado".
--
-- Transcrição de áudio não é cobrada por token: o Whisper cobra por MINUTO.
-- Sem esta coluna o áudio ficava fora da conta (a linha nem era gravada, já
-- que uma captura sem token é descartada).
ALTER TABLE "ai_usage" ADD COLUMN IF NOT EXISTS "audio_seconds" integer DEFAULT 0 NOT NULL;

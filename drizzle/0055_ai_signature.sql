-- Assinatura da IA: nome do atendente que a IA representa + se assina as mensagens.
ALTER TABLE "ai_configs"
  ADD COLUMN IF NOT EXISTS "signature_name" text,
  ADD COLUMN IF NOT EXISTS "signature_enabled" boolean DEFAULT false NOT NULL;

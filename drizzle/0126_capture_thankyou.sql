-- ============================================================
-- Obrigado que Vende (Captação): a tela de sucesso vira ativo de conversão —
-- bloco de oferta (título + texto), botão "Chamar no WhatsApp" (link wa.me com
-- o ref rastreado do form) e cadência automática pra quem envia (reusa o motor
-- de cadências; pausa quando o lead responde).
-- ============================================================

ALTER TABLE capture_forms
  ADD COLUMN IF NOT EXISTS success_offer_title text,
  ADD COLUMN IF NOT EXISTS success_offer_text text,
  ADD COLUMN IF NOT EXISTS success_whatsapp boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS cadence_id uuid;

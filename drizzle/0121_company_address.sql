-- ============================================================
-- Endereço da empresa (emissor da proposta). Opcional, mas deixa a proposta mais
-- profissional. Preenchido à mão ou automático pela busca de CNPJ (BrasilAPI).
-- ============================================================

ALTER TABLE ai_company_profile
  ADD COLUMN IF NOT EXISTS address text;

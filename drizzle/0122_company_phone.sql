-- ============================================================
-- Telefone do emissor da proposta (Dados da empresa). Aparece no cabeçalho da
-- proposta, junto de CNPJ/endereço/site. Preenchido à mão ou pela busca de CNPJ.
-- ============================================================

ALTER TABLE ai_company_profile
  ADD COLUMN IF NOT EXISTS phone text;

-- ============================================================
-- Dados da empresa (emissor das propostas): identidade fiscal/comercial da
-- conta. Além do que o perfil já tinha (nome/descrição/pagamento), agora guarda
-- razão social, nome fantasia, CNPJ/CPF e site — que aparecem no cabeçalho da
-- proposta. O LOGO fica em organization.logo (separado do avatar do usuário).
-- ============================================================

ALTER TABLE ai_company_profile
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS trade_name text,
  ADD COLUMN IF NOT EXISTS document text,
  ADD COLUMN IF NOT EXISTS website text;

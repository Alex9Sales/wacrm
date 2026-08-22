-- ============================================================
-- Seção Propostas: marca "das duas formas". A proposta pode usar a marca do
-- perfil da conta (padrão) OU sobrescrever por proposta (nome/logo/tagline/formas
-- de pagamento). seller_override guarda o override quando existe; null = perfil.
-- ============================================================

ALTER TABLE deal_proposals
  ADD COLUMN IF NOT EXISTS seller_override jsonb;

-- ============================================================
-- Proposta com ACEITE DIGITAL + rastreio. Fecha o loop da proposta: hoje o
-- vendedor manda o link e fica cego. Agora a página pública carimba a 1ª
-- visualização e oferece um botão "Aceitar" (nome + CPF/CNPJ + IP). Cada evento
-- notifica o vendedor e entra na timeline do negócio.
-- ============================================================

ALTER TABLE deal_proposals
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS acceptor_name text,
  ADD COLUMN IF NOT EXISTS acceptor_document text,
  ADD COLUMN IF NOT EXISTS acceptor_ip text;

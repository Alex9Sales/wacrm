-- ============================================================
-- RD Station Marketing como fonte de lead (Limpeza com Zelo, 17/09).
-- O lead converte no RD (formulário, landing page, anúncio) e o RD dispara um
-- webhook pra cá; a partir daí é o mesmo caminho do Lead Ads: contato + card no
-- funil + primeira mensagem.
--
-- O RD NÃO assina o webhook (não tem segredo nem HMAC), então o segredo vai na
-- própria URL e é gravado em external_account_id — que já é a chave de
-- roteamento da tabela e já tem índice (provider, external_account_id).
-- ============================================================

ALTER TABLE lead_ad_sources DROP CONSTRAINT IF EXISTS lead_ad_sources_provider_check;
ALTER TABLE lead_ad_sources ADD CONSTRAINT lead_ad_sources_provider_check
  CHECK (provider = ANY (ARRAY['tiktok'::text, 'meta'::text, 'linkedin'::text, 'rdstation'::text]));

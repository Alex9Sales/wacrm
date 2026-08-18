-- ============================================================
-- 0100 — Libera provider='linkedin' nas fontes de Anúncios de Lead.
-- LinkedIn Lead Sync API entra como fonte de INGESTÃO (igual Meta/TikTok):
-- lead do Lead Gen Form → contato + card no funil. Roteia por organization id
-- (external_account_id). Aplicar nos DOIS bancos (dev crmfluxia + prod crmfluxia_prod).
-- ============================================================

ALTER TABLE lead_ad_sources DROP CONSTRAINT IF EXISTS lead_ad_sources_provider_check;
ALTER TABLE lead_ad_sources ADD CONSTRAINT lead_ad_sources_provider_check
  CHECK (provider = ANY (ARRAY['tiktok'::text, 'meta'::text, 'linkedin'::text]));

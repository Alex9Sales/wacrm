-- Anúncios de Lead (Lead Ads): fontes de lead do TikTok e do Meta.
-- INGESTÃO (não é canal de mensagem): o lead do formulário do anúncio vira
-- contato + card no funil (mesmo caminho do /api/v1/leads → ingestLead).
-- Roteia o webhook por external_account_id (page_id no Meta, advertiser_id no
-- TikTok) + form_id opcional.

CREATE TABLE IF NOT EXISTS lead_ad_sources (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  provider text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'connected',
  external_account_id text,
  form_id text,
  -- token criptografado (AES-256-GCM), como as credenciais dos canais.
  access_token text NOT NULL,
  verify_token text,
  pipeline_id uuid,
  stage_id uuid,
  deliver_to_ai boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  provider_meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT lead_ad_sources_provider_check CHECK (provider = ANY (ARRAY['tiktok'::text, 'meta'::text])),
  CONSTRAINT lead_ad_sources_account_id_name_key UNIQUE (account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_lead_ad_sources_account
  ON lead_ad_sources (account_id);

-- Roteamento do webhook: acha a fonte por (provider, external_account_id).
CREATE INDEX IF NOT EXISTS idx_lead_ad_sources_route
  ON lead_ad_sources (provider, external_account_id);

-- 🌐 Domínio próprio das páginas de captação (aponta CNAME → páginas /f/*
-- respondem no domínio do cliente). Aplicar nos DOIS bancos.
CREATE TABLE IF NOT EXISTS capture_domains (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  domain text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_domains_domain ON capture_domains (domain);
CREATE INDEX IF NOT EXISTS idx_capture_domains_account ON capture_domains (account_id);

-- Empresas como ENTIDADE (Fase 1). Antes "empresa" era só texto livre no
-- contato (contacts.company); agora vira entidade própria com contatos ligados.
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  segment text,
  website text,
  phone text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_companies_account ON companies(account_id);
-- Nome único por conta (case-insensitive) — evita empresas duplicadas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_account_name ON companies(account_id, lower(name));

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id uuid;
DO $$ BEGIN
  ALTER TABLE contacts ADD CONSTRAINT contacts_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);

-- Backfill: cada valor distinto de contacts.company (por conta, case-insensitive)
-- vira uma empresa e liga os contatos. Idempotente (guarda por NOT EXISTS).
INSERT INTO companies (account_id, name)
SELECT DISTINCT c.account_id, btrim(c.company)
FROM contacts c
WHERE c.company IS NOT NULL AND btrim(c.company) <> ''
  AND NOT EXISTS (
    SELECT 1 FROM companies co
    WHERE co.account_id = c.account_id AND lower(co.name) = lower(btrim(c.company))
  );

UPDATE contacts c
SET company_id = co.id
FROM companies co
WHERE co.account_id = c.account_id
  AND lower(co.name) = lower(btrim(c.company))
  AND c.company IS NOT NULL AND btrim(c.company) <> ''
  AND c.company_id IS NULL;

-- Empresas Fase 2: negócio ↔ empresa DIRETO + vários contatos por negócio.

-- 1) Vínculo direto do negócio com a empresa.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_id uuid;
DO $$ BEGIN
  ALTER TABLE deals ADD CONSTRAINT deals_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);

-- Backfill: herda a empresa do contato PRINCIPAL do negócio.
UPDATE deals d
SET company_id = c.company_id
FROM contacts c
WHERE c.id = d.contact_id
  AND c.company_id IS NOT NULL
  AND d.company_id IS NULL;

-- 2) Contatos adicionais do negócio (o principal segue em deals.contact_id).
CREATE TABLE IF NOT EXISTS deal_contacts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_contacts_deal_contact ON deal_contacts(deal_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_deal_contacts_deal ON deal_contacts(deal_id);

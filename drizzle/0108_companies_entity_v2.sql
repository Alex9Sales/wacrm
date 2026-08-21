-- Empresas como ENTIDADE DE VERDADE (v2): ficha rica + etiquetas + histórico + anexos.
-- Aditivo e backward-compat.

-- Ficha rica na tabela companies.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS document text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS assigned_to uuid;
DO $$ BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT companies_assigned_to_fkey
    FOREIGN KEY (assigned_to) REFERENCES "user"(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Etiquetas da empresa (reusa a tabela tags, como contact_tags).
CREATE TABLE IF NOT EXISTS company_tags (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_tags_unique ON company_tags (company_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_company_tags_company ON company_tags (company_id);

-- Histórico/atividade da empresa (timeline: notas + eventos).
CREATE TABLE IF NOT EXISTS company_events (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id uuid,
  type text NOT NULL,
  data jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_events_company ON company_events (company_id, created_at);

-- Anexos/arquivos da empresa (metadados; binário no MinIO).
CREATE TABLE IF NOT EXISTS company_attachments (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  mime text,
  size integer,
  uploaded_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_attachments_company ON company_attachments (company_id);

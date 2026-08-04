-- Produtos (itens/valores por negócio) e Arquivos (anexos) do lead no funil,
-- estilo RD. Produtos: linhas livres nome × qtd × preço unitário. Arquivos:
-- metadados do anexo (o binário vive no MinIO, url pública).
CREATE TABLE IF NOT EXISTS "deal_products" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "quantity" numeric(12,2) NOT NULL DEFAULT 1,
  "unit_price" numeric(12,2) NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_deal_products_deal" ON "deal_products" ("deal_id");

CREATE TABLE IF NOT EXISTS "deal_attachments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "url" text NOT NULL,
  "mime" text,
  "size" integer,
  "uploaded_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_deal_attachments_deal" ON "deal_attachments" ("deal_id");

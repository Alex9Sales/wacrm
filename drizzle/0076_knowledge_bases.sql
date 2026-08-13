-- Fase K (Base de Conhecimento híbrida): bases NOMEADAS por conta + seleção por
-- agente. As bases ficam na CONTA; cada agente escolhe quais usa
-- (ai_configs.knowledge_base_ids, VAZIO = todas). Documentos e chunks passam a
-- pertencer a uma base. Migra o que já existe para uma base "Núcleo" por conta
-- (nada se perde). Idempotente.

-- 1) Tabela de bases.
CREATE TABLE IF NOT EXISTS "ai_knowledge_bases" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "account_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_knowledge_bases_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "ai_knowledge_bases_account_id_idx" ON "ai_knowledge_bases" USING btree ("account_id");

-- 2) Documentos: base + tipo de fonte (+ campos p/ Q&A, URL, arquivo, status).
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "knowledge_base_id" uuid;
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "source_type" text DEFAULT 'text' NOT NULL;
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "question" text;
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "source_url" text;
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "file_name" text;
ALTER TABLE "ai_knowledge_documents" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'ready' NOT NULL;

DO $$ BEGIN
  ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_source_type_check"
    CHECK (source_type = ANY (ARRAY['text'::text,'file'::text,'url'::text,'qa'::text,'approval'::text]));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Chunks: base denormalizada (filtra o retrieval por base sem join).
ALTER TABLE "ai_knowledge_chunks" ADD COLUMN IF NOT EXISTS "knowledge_base_id" uuid;

-- 4) Seleção de bases por agente (VAZIO = todas as bases da conta).
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "knowledge_base_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;

-- 5) Backfill: uma base "Núcleo" por conta que já tem documentos → aponta docs + chunks.
WITH accts AS (
  SELECT DISTINCT account_id FROM "ai_knowledge_documents" WHERE knowledge_base_id IS NULL
), ins AS (
  INSERT INTO "ai_knowledge_bases" (account_id, name, description)
  SELECT account_id, 'Núcleo', 'Base principal (migrada)' FROM accts
  RETURNING id, account_id
)
UPDATE "ai_knowledge_documents" d
  SET knowledge_base_id = ins.id
  FROM ins
  WHERE d.account_id = ins.account_id AND d.knowledge_base_id IS NULL;

UPDATE "ai_knowledge_chunks" c
  SET knowledge_base_id = d.knowledge_base_id
  FROM "ai_knowledge_documents" d
  WHERE c.document_id = d.id AND c.knowledge_base_id IS NULL;

-- 6) FKs + índices por base (após o backfill).
DO $$ BEGIN
  ALTER TABLE "ai_knowledge_documents" ADD CONSTRAINT "ai_knowledge_documents_kb_fkey"
    FOREIGN KEY ("knowledge_base_id") REFERENCES "ai_knowledge_bases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ai_knowledge_chunks" ADD CONSTRAINT "ai_knowledge_chunks_kb_fkey"
    FOREIGN KEY ("knowledge_base_id") REFERENCES "ai_knowledge_bases"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "ai_knowledge_documents_kb_idx" ON "ai_knowledge_documents" USING btree ("knowledge_base_id");
CREATE INDEX IF NOT EXISTS "ai_knowledge_chunks_account_kb_idx" ON "ai_knowledge_chunks" USING btree ("account_id","knowledge_base_id");

-- 7) Overloads das match functions com filtro de BASES (p_base_ids vazio = todas).
--    COALESCE trata array nulo como "sem filtro". Aridade 4 → coexistem com as de 3.
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  UUID,
  p_query       TEXT,
  p_match_count INTEGER,
  p_base_ids    UUID[]
)
RETURNS TABLE (id UUID, content TEXT, rank REAL) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
    AND (COALESCE(cardinality(p_base_ids), 0) = 0 OR c.knowledge_base_id = ANY(p_base_ids))
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SET search_path = public;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      UUID,
  p_query_embedding TEXT,
  p_match_count     INTEGER,
  p_base_ids        UUID[]
)
RETURNS TABLE (id UUID, content TEXT, distance REAL) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND (COALESCE(cardinality(p_base_ids), 0) = 0 OR c.knowledge_base_id = ANY(p_base_ids))
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SET search_path = public;

-- Fase B — etiqueta no atendente. Reusa as etiquetas da conta (tags) marcando
-- MEMBROS (ex.: "Gerente"). A IA transfere pra quem tem a etiqueta escolhida.
CREATE TABLE IF NOT EXISTS "member_tags" (
  "member_id" uuid NOT NULL,
  "tag_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("member_id", "tag_id"),
  CONSTRAINT "member_tags_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "member"("id") ON DELETE CASCADE,
  CONSTRAINT "member_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "member_tags_tag_idx" ON "member_tags" ("tag_id");

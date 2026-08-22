-- ============================================================
-- Previsão de receita ("vou bater a meta?"): probabilidade de fechamento por
-- ETAPA do funil (0–100). Editável na Config do funil. O card de previsão pondera
-- os negócios ABERTOS por (valor × probabilidade da etapa) e projeta contra a
-- meta (sales_goals). Default 50; backfill linear por posição (10% na 1ª → 90%
-- na última) pra cada funil já existente.
-- ============================================================

ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS probability integer NOT NULL DEFAULT 50;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY pipeline_id ORDER BY position) - 1 AS idx,
    count(*) OVER (PARTITION BY pipeline_id) AS cnt
  FROM pipeline_stages
)
UPDATE pipeline_stages ps
SET probability = CASE
  WHEN r.cnt <= 1 THEN 50
  ELSE round(10 + (r.idx::numeric / (r.cnt - 1)) * 80)::int
END
FROM ranked r
WHERE r.id = ps.id;

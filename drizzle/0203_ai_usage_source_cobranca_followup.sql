-- 0203 — Medidor de custo da IA: o banco passa a aceitar as origens
-- 'collections' (cobrança) e 'followup' (follow-up da IA, lembretes, gatilho
-- de etapa). 01/10/2026.
--
-- O tipo UsageSource (src/lib/ai/types.ts) ganhou 'collections' em 23/09, mas
-- o CHECK desta coluna (0124) nunca foi recriado: todo INSERT da cobrança em
-- ai_usage falhava, recordAiUsage engolia o erro e o gasto da IA da régua de
-- cobrança sumia do medidor (conferido em produção: zero linhas 'collections'
-- em 30 dias). O follow-up gravava como 'inbox' só por falta de rótulo próprio.
--
-- Recria o CHECK com a lista anterior + as duas novas.

ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_source_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_source_check CHECK (source = ANY (ARRAY[
  'inbox'::text, 'draft'::text, 'playground'::text, 'pipeline'::text,
  'flow'::text, 'deal_suggest'::text, 'vision'::text, 'transcribe'::text,
  'tts'::text, 'embeddings'::text, 'capture'::text,
  'collections'::text, 'followup'::text
]));

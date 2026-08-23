-- ============================================================
-- Link Zap + QR rastreado (Captação): cada formulário/landing ganha um ref
-- curto (#F7K2) embutido no link wa.me / QR. Quando o "Oi" chega no inbound com
-- o ref, o lead vira card no funil com a ORIGEM EXATA (nome do form) e o agente
-- do canal assume. wa_leads conta os leads que chegaram por esse caminho.
-- ============================================================

ALTER TABLE capture_forms
  ADD COLUMN IF NOT EXISTS wa_ref text,
  ADD COLUMN IF NOT EXISTS wa_leads integer DEFAULT 0 NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_forms_wa_ref
  ON capture_forms (upper(wa_ref)) WHERE wa_ref IS NOT NULL;

-- Backfill: ref pros formulários existentes (5 hex chars são únicos o bastante
-- aqui; novos refs saem do app com charset sem ambiguidade).
UPDATE capture_forms
SET wa_ref = upper(substr(md5(id::text || clock_timestamp()::text), 1, 5))
WHERE wa_ref IS NULL;

-- Paridade com o RD (funil): campos no negócio.
--  • lost_reason      → motivo ao marcar PERDA (aparece no evento + no detalhe).
--  • qualification    → nota 1..5 (estrela do card, estilo RD ★N).
--  • stage_changed_at → quando o deal entrou na etapa ATUAL, p/ "dias na etapa".
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS qualification smallint;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz;

-- Backfill: entrou na etapa atual = último stage_changed do histórico, senão a
-- criação do negócio.
UPDATE deals
SET stage_changed_at = COALESCE(
  (SELECT MAX(e.created_at) FROM deal_events e
     WHERE e.deal_id = deals.id AND e.type = 'stage_changed'),
  created_at
)
WHERE stage_changed_at IS NULL;

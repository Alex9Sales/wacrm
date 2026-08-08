-- Pausar negociação (estilo RD): fica na etapa, mas marcada como pausada
-- (badge no card). paused_at = quando foi pausada; NULL = ativa.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS paused_at timestamptz;

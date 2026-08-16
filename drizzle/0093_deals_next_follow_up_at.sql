-- Próximo follow-up agendado do card (follow-up por etapa): o card mostra
-- "próximo follow-up: <data>" e o worker dispara quando vence. O sistema atualiza
-- isto ao mover o card de etapa (e limpa ao disparar). Estilo due_date do n8n.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_follow_up_at timestamptz;

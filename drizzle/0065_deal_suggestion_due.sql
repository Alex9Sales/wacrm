-- IA v2 Fase 2: sugestão de FOLLOW-UP (tarefa) precisa de data. Reusa
-- deal_suggestions com kind='task' (value=título, evidence=motivo, due_at=quando).
ALTER TABLE deal_suggestions ADD COLUMN IF NOT EXISTS due_at timestamptz;

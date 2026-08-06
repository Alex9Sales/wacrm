-- Tarefas com VÁRIOS responsáveis (spec Alex): além do `assigned_to` (que
-- passa a ser o responsável PRIMÁRIO, p/ compatibilidade com telas e joins que
-- já existem), a tarefa carrega uma LISTA `assignee_ids`. Um agente pode
-- delegar/mar­car outros (admin, supervisor, outros agentes) e a tarefa aparece
-- pra quem criou + cada responsável marcado. GIN index p/ o filtro de
-- visibilidade `assignee_ids @> ARRAY[user]`.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assignee_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- Backfill: quem já tinha um responsável vira o primeiro (e único) da lista.
UPDATE tasks
   SET assignee_ids = ARRAY[assigned_to]::uuid[]
 WHERE assigned_to IS NOT NULL
   AND cardinality(assignee_ids) = 0;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee_ids
  ON tasks USING gin (assignee_ids);

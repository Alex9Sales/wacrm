-- Atividades automáticas por etapa (sequência do funil, item 2).
-- Cada etapa pode definir "templates" de tarefa; quando um negócio ENTRA na
-- etapa, o CRM materializa esses templates em linhas de `tasks` para o
-- responsável do negócio. Dedupe por (deal, template) via tasks.source_template_id.
CREATE TABLE IF NOT EXISTS stage_task_templates (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  due_offset_days integer DEFAULT 0 NOT NULL,
  type text,
  position integer DEFAULT 0 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stage_task_templates_stage ON stage_task_templates (stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_task_templates_account ON stage_task_templates (account_id);

-- Origem da tarefa: qual template de etapa a criou (dedupe na reentrada +
-- marca a tarefa como automática). ON DELETE SET NULL: apagar o template não
-- apaga tarefas já criadas.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_template_id uuid
  REFERENCES stage_task_templates(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_template ON tasks (source_template_id);

-- Dedupe robusto (corrida / duplo-clique / duplo-hook): no máximo UMA tarefa
-- por (negócio, template). Parcial porque source_template_id é quase sempre NULL
-- (tarefas manuais). Com isso o insert usa ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_deal_source_template
  ON tasks (deal_id, source_template_id) WHERE source_template_id IS NOT NULL;

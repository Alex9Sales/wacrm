-- ============================================================
-- Captação self-serve: formulários públicos por conta. Generaliza o /diagnostico
-- num construtor simples — cada conta cria um formulário (campos + funil/etapa de
-- destino + origem), publica em /f/<slug> e os leads caem direto no funil dela
-- (via ingestLead: contato + card + tarefa + rodízio). MVP sem construtor visual:
-- campos padrão (nome/telefone/email/empresa/mensagem) ligáveis + obrigatórios.
-- ============================================================

CREATE TABLE IF NOT EXISTS capture_forms (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  headline text,
  description text,
  success_message text,
  submit_label text,
  fields jsonb DEFAULT '[]'::jsonb NOT NULL,
  pipeline_id uuid,
  stage_id uuid,
  origin text DEFAULT 'Formulário' NOT NULL,
  theme text DEFAULT 'light' NOT NULL,
  active boolean DEFAULT true NOT NULL,
  submissions integer DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- slug é a chave do link público /f/<slug> — único globalmente (resolve sem conta).
CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_forms_slug ON capture_forms (slug);
CREATE INDEX IF NOT EXISTS idx_capture_forms_account ON capture_forms (account_id);

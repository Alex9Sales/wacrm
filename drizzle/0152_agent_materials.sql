-- 📎 Materiais do agente (01/09, Limpeza com Zelo): arquivos/imagens/vídeos que a
-- IA pode ENVIAR na conversa via [[ENVIAR:nome]] quando o prompt mandar.
CREATE TABLE IF NOT EXISTS agent_materials (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL,
  -- NULL = disponível pra todos os agentes da conta.
  agent_id uuid NULL REFERENCES ai_configs(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NULL,
  media_type text NOT NULL CHECK (media_type IN ('image','video','document')),
  media_url text NOT NULL,
  filename text NULL,
  mimetype text NULL,
  size_bytes integer NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_materials_account ON agent_materials (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_materials_account_name ON agent_materials (account_id, lower(name));

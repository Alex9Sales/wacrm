-- 🔧 Ferramentas externas por agente (Fase T1) — a IA chama APIs do cliente
-- (ERP, estoque, pedidos) sem n8n. Tool HTTP configurável + governança por
-- categoria de risco + histórico de execução (auditoria/debug).
-- Caso piloto: Família do Gás (buscar cliente, estoque, criar pedido).

CREATE TABLE IF NOT EXISTS agent_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- Ferramenta pertence a UM agente (v1). NULL nunca é usado hoje.
  agent_id uuid NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- slug estável usado no marcador [[FERRAMENTA: slug | {...}]]
  slug text NOT NULL,
  -- descrição voltada à IA: quando e pra que usar
  description text NOT NULL,
  method text NOT NULL DEFAULT 'GET',
  -- URL com {placeholders} dos parâmetros
  url text NOT NULL,
  -- headers de autenticação CRIPTOGRAFADOS (AES-GCM, mesmo esquema dos canais):
  -- ciphertext de um JSON { "Authorization": "Bearer x", ... }
  headers_enc text,
  -- [{ name, type, description, required }]
  params jsonb NOT NULL DEFAULT '[]',
  -- POST/PUT: template JSON do corpo com {placeholders} (null = params na query)
  body_template text,
  -- 🟢 read | 🟡 write | 🔴 critical (crítica NÃO executa sozinha na v1)
  risk text NOT NULL DEFAULT 'read',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_tools_method_check CHECK (method = ANY (ARRAY['GET','POST','PUT','PATCH','DELETE'])),
  CONSTRAINT agent_tools_risk_check CHECK (risk = ANY (ARRAY['read','write','critical'])),
  CONSTRAINT agent_tools_agent_slug_unique UNIQUE (agent_id, slug)
);
CREATE INDEX IF NOT EXISTS agent_tools_account_idx ON agent_tools (account_id);
CREATE INDEX IF NOT EXISTS agent_tools_agent_idx ON agent_tools (agent_id, enabled);

-- Histórico de execução ("Histórico de ações"): o antídoto do
-- "a IA fez algo errado mas ninguém sabe o quê".
CREATE TABLE IF NOT EXISTS agent_tool_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  tool_id uuid REFERENCES agent_tools(id) ON DELETE SET NULL,
  agent_id uuid,
  conversation_id uuid,
  tool_slug text NOT NULL,
  args jsonb,
  -- ok | error | blocked (crítica barrada) | invalid (args ruins)
  status text NOT NULL,
  -- resposta truncada (ou mensagem de erro) pra auditoria
  result_summary text,
  http_status int,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_tool_runs_account_idx ON agent_tool_runs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_tool_runs_tool_idx ON agent_tool_runs (tool_id, created_at DESC);

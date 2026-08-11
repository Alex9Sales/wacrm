-- Multi-agente: ai_configs deixa de ser 1-por-conta e vira MUITOS (cada linha
-- = um agente: SDR, Follow-up, Vendas, Suporte...). O roteamento é por CANAL
-- (autoReplyChannelIds, que já existia). Um agente por conta é o DEFAULT:
-- fallback do draft/pipelines/playground + catch-all do auto-reply.

ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- Nome amigável pra quem ainda não tem.
UPDATE ai_configs SET name = 'Agente principal'
  WHERE name IS NULL OR btrim(name) = '';

-- Elege UM default por conta (o mais antigo), só se a conta ainda não tem um.
-- Idempotente: seguro se re-rodar depois que já existirem vários agentes.
UPDATE ai_configs c SET is_default = true
  WHERE is_default = false
    AND NOT EXISTS (
      SELECT 1 FROM ai_configs d
      WHERE d.account_id = c.account_id AND d.is_default = true
    )
    AND c.id = (
      SELECT e.id FROM ai_configs e
      WHERE e.account_id = c.account_id
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT 1
    );

-- Deixa de ser 1-por-conta.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_account_id_key;

-- No máximo UM default por conta.
CREATE UNIQUE INDEX IF NOT EXISTS ai_configs_one_default_per_account
  ON ai_configs (account_id) WHERE is_default;

-- Lookup por conta (a antiga unique servia de índice; recria como comum).
CREATE INDEX IF NOT EXISTS ai_configs_account_idx ON ai_configs (account_id);

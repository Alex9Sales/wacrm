-- Fase B — Medidor de custo da IA. Uma linha APPEND-ONLY por chamada de modelo
-- (inspirado no LlmUsage do fazer.ai/agents, open source). Guarda só TOKENS; o
-- custo (US$/R$) é calculado na query a partir da tabela de preços por modelo
-- (src/lib/ai/pricing.ts) — sem depender de Langfuse nem de serviço externo.
--
-- Semântica dos tokens (normalizada na captura, ver src/lib/ai/usage.ts):
--   prompt_tokens        = TOTAL de input (inclui cache), base de cobrança
--   completion_tokens    = output
--   cached_read_tokens   = subconjunto de prompt lido do cache (descontado)
--   cache_creation_tokens= subconjunto escrito no cache (Anthropic, premium)

CREATE TABLE IF NOT EXISTS ai_usage (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id            uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  -- O agente (ai_configs.id) que respondeu. NULL em fluxos sem agente resolvido.
  agent_id              uuid REFERENCES ai_configs(id) ON DELETE SET NULL,
  -- Conversa e canal (inbox) atribuídos. NULL no playground / testes de chave.
  conversation_id       uuid REFERENCES conversations(id) ON DELETE SET NULL,
  channel_id            uuid REFERENCES channels(id) ON DELETE SET NULL,
  provider              text NOT NULL,
  model                 text NOT NULL,
  -- De onde veio a chamada (mantém o teste separado do tráfego real no painel).
  source                text NOT NULL DEFAULT 'inbox',
  prompt_tokens         integer NOT NULL DEFAULT 0,
  completion_tokens     integer NOT NULL DEFAULT 0,
  cached_read_tokens    integer NOT NULL DEFAULT 0,
  cache_creation_tokens integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_source_check CHECK (source = ANY (ARRAY[
    'inbox'::text, 'draft'::text, 'playground'::text, 'pipeline'::text,
    'flow'::text, 'deal_suggest'::text, 'vision'::text, 'transcribe'::text,
    'tts'::text, 'embeddings'::text
  ]))
);

-- Janela temporal do painel (mais recente primeiro).
CREATE INDEX IF NOT EXISTS ai_usage_account_created_idx
  ON ai_usage (account_id, created_at DESC);
-- Break-down por agente / canal / conversa.
CREATE INDEX IF NOT EXISTS ai_usage_account_agent_idx
  ON ai_usage (account_id, agent_id);
CREATE INDEX IF NOT EXISTS ai_usage_account_channel_idx
  ON ai_usage (account_id, channel_id);
CREATE INDEX IF NOT EXISTS ai_usage_account_conversation_idx
  ON ai_usage (account_id, conversation_id);

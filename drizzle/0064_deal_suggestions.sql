-- IA para Negociações v2 — Fase 1: sugestões por evidência.
-- A IA propõe valores (campos do negócio + campos personalizados do contato)
-- COM a evidência; o humano aceita (aplica) ou descarta. Nada é gravado sozinho.
CREATE TABLE IF NOT EXISTS deal_suggestions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'field',       -- 'field' (fase 1); 'task'/'note' depois
  target text NOT NULL,                      -- 'deal:temperature' | 'custom:<field_id>' ...
  label text NOT NULL,                       -- rótulo p/ exibir
  value text NOT NULL,                       -- valor sugerido
  evidence text,                             -- trecho/motivo que embasou
  status text NOT NULL DEFAULT 'pending',    -- pending | accepted | dismissed
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deal_suggestions_deal ON deal_suggestions (deal_id, status);

-- Metas de venda por responsável (fase 5 do funil). Uma meta MENSAL por
-- pessoa (valor em R$ e/ou nº de vendas). O relatório por responsável mostra
-- o progresso (valorGanho / meta) no período selecionado.
CREATE TABLE IF NOT EXISTS sales_goals (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  target_value numeric(14,2) DEFAULT 0 NOT NULL,   -- meta em R$ (mensal)
  target_count integer DEFAULT 0 NOT NULL,          -- meta em nº de vendas (mensal)
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_goals_account ON sales_goals (account_id);

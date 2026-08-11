-- Perfil da empresa ("Núcleo" guiado) — a camada estruturada da Base de
-- Conhecimento. Uma linha por conta. Diferente dos documentos livres
-- (ai_knowledge_documents), estes campos são SEMPRE injetados no contexto do
-- agente (buildSystemPrompt), não dependem do retrieval casar a pergunta —
-- é o "quem somos / o que vendemos" que o agente precisa saber sempre.
CREATE TABLE IF NOT EXISTS ai_company_profile (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  business_name text,        -- nome do negócio
  description text,          -- o que a empresa faz / sobre
  offerings text,            -- principais produtos/serviços
  hours text,                -- horário de atendimento
  payment_methods text,      -- formas de pagamento
  delivery_info text,        -- entrega / endereço / região atendida
  tone text,                 -- tom de voz do atendimento
  notes text,                -- observações gerais
  updated_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_company_profile_account_key UNIQUE (account_id)
);

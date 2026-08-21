-- Propostas do negócio (Fase funil): documento profissional com desconto,
-- validade e termos. 1 proposta por negócio (v1). O id é o token do link público.
CREATE TABLE IF NOT EXISTS deal_proposals (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  discount numeric(12,2) DEFAULT 0 NOT NULL,
  discount_type text DEFAULT 'value' NOT NULL,
  valid_until date,
  terms text,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_proposals_deal ON deal_proposals (deal_id);

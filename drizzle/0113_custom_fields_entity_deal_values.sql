-- Campos personalizados (fase 3 do funil): campos também no NEGÓCIO + tipos
-- novos (number/date/boolean/currency — só valores de field_type, sem migração
-- de schema). Aqui: escopo do campo (contato|negócio) + valores por negócio.

-- A qual entidade o campo pertence. Os existentes = contato.
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS entity text DEFAULT 'contact' NOT NULL;

-- Valores dos campos personalizados DO NEGÓCIO (espelha contact_custom_values).
CREATE TABLE IF NOT EXISTS deal_custom_values (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  custom_field_id uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (deal_id, custom_field_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_custom_values_deal ON deal_custom_values (deal_id);

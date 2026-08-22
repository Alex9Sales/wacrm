-- Distribuição automática de leads (rodízio). Config por conta. Migração 0115.
CREATE TABLE IF NOT EXISTS lead_distribution (
  account_id uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  strategy text NOT NULL DEFAULT 'round_robin',        -- 'round_robin' | 'load'
  member_ids jsonb NOT NULL DEFAULT '[]'::jsonb,       -- user ids no rodízio
  last_assigned_user_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

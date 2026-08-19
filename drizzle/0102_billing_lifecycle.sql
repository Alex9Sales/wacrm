-- ============================================================
-- 0102 — Ciclo de vida da conta/assinatura: cancelamento + exclusão (soft) +
-- histórico. Cancelar = vale até o vencimento pago (cancel_at). Excluir =
-- soft-delete (deleted_at) mantendo o registro. billing_events = trilha de
-- auditoria de tudo (quem/quando/por quê). Aplicar nos DOIS bancos.
-- ============================================================

-- status ganha 'canceled'
ALTER TABLE organization_billing DROP CONSTRAINT IF EXISTS organization_billing_status_check;
ALTER TABLE organization_billing ADD CONSTRAINT organization_billing_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'suspended'::text, 'trial'::text, 'canceled'::text]));

-- soft-delete + data efetiva do cancelamento (fim do período pago)
ALTER TABLE organization_billing ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE organization_billing ADD COLUMN IF NOT EXISTS cancel_at timestamptz;

-- Histórico de eventos de billing (provisionamento, ativação, suspensão,
-- cancelamento, exclusão, mudança de plano, lembrete, pagamento…).
CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  event text NOT NULL,
  from_status text,
  to_status text,
  actor_type text NOT NULL DEFAULT 'admin', -- admin | client | system
  actor_id uuid,
  actor_label text,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events (organization_id, created_at DESC);

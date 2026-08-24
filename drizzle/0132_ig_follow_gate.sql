-- 🔒 Follow gate (social selling): a automação de comentários pode exigir que a
-- pessoa SIGA o perfil antes de receber o DM com o link. Pendências guardam
-- quem comentou sem seguir; a entrega acontece quando a pessoa responde a DM
-- já seguindo. Aplicar nos DOIS bancos.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS follow_gate boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS follow_gate_message text;

CREATE TABLE IF NOT EXISTS instagram_follow_gate_pending (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  automation_id uuid NOT NULL REFERENCES instagram_comment_automations(id) ON DELETE CASCADE,
  ig_user_id text NOT NULL,
  reminded boolean NOT NULL DEFAULT false,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_fgate_rule_user ON instagram_follow_gate_pending (automation_id, ig_user_id);
CREATE INDEX IF NOT EXISTS idx_ig_fgate_lookup ON instagram_follow_gate_pending (channel_id, ig_user_id) WHERE NOT delivered;

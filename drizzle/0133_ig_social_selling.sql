-- 📸 Social selling IG (parte 2): stories + follow-up pós-DM.
-- Follow-up: SÓ pra quem RESPONDEU a DM (janela de 24h aberta) — a API da
-- Meta permite 1 única resposta privada por comentário; quem nunca respondeu
-- não pode receber outra mensagem. Aplicar nos DOIS bancos.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS follow_up_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS follow_up_hours integer NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS follow_up_message text;
ALTER TABLE instagram_comment_events
  ADD COLUMN IF NOT EXISTS follow_up_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS instagram_story_settings (
  channel_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  reply_enabled boolean NOT NULL DEFAULT false,
  reply_message text,
  mention_enabled boolean NOT NULL DEFAULT false,
  mention_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS instagram_story_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id uuid NOT NULL,
  ig_user_id text NOT NULL,
  kind text NOT NULL,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_story_log_unique ON instagram_story_log (channel_id, ig_user_id, kind);

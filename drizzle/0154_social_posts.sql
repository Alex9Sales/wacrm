-- 📸 Publicações no Instagram feitas de dentro do CRM (post, carrossel, reels,
-- story) com agendamento e automação comentário→DM amarrada ao post publicado.
-- Pedido do Alex 02/09: "o cliente cria o Post, reels etc. e já faz a automação de DM".
CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by uuid,
  -- image | carousel | reel | story
  kind text NOT NULL,
  caption text NOT NULL DEFAULT '',
  -- [{ url, type: 'image'|'video', name? }] — URLs públicas do proxy /api/files
  media jsonb NOT NULL DEFAULT '[]'::jsonb,
  share_to_feed boolean NOT NULL DEFAULT true,
  cover_url text,
  -- draft | scheduled | publishing | published | failed | canceled
  status text NOT NULL DEFAULT 'draft',
  scheduled_at timestamptz,
  published_at timestamptz,
  ig_media_id text,
  permalink text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  -- máquina de estados do publicador (stage, containerId, childIds, startedAt)
  publish_state jsonb,
  -- automação comentário→DM a criar quando publicar (keywords, replies, dm…)
  automation_draft jsonb,
  automation_id uuid REFERENCES instagram_comment_automations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_account ON social_posts (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts (scheduled_at) WHERE status IN ('scheduled', 'publishing');
COMMENT ON TABLE social_posts IS 'Publicações no Instagram feitas pelo CRM (post, carrossel, reels, story) + automação comentário→DM amarrada ao post publicado.';

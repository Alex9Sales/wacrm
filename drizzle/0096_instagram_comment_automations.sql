-- Automação de comentário→DM do Instagram.
-- Quando alguém comenta (uma palavra-chave) num post da conta, o CRM responde
-- o comentário e/ou manda um DM (resposta privada) com o link — API oficial.
--
-- Duas tabelas: as REGRAS (por canal IG) e um LOG/DEDUP dos comentários
-- processados (o índice único (channel_id, comment_id) evita responder 2x
-- quando a Meta re-entrega o webhook).

-- 1) Regras de automação (por canal).
CREATE TABLE IF NOT EXISTS instagram_comment_automations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- match_any = responde QUALQUER comentário (ignora keywords).
  match_any boolean NOT NULL DEFAULT false,
  -- keywords separadas por vírgula (casa se o comentário CONTÉM qualquer uma).
  keywords text NOT NULL DEFAULT '',
  -- resposta pública no próprio comentário (opcional).
  public_reply text,
  -- DM/resposta privada mandada a quem comentou (obrigatório).
  dm_message text NOT NULL,
  -- não mandar o mesmo DM 2x pra mesma pessoa nessa regra.
  once_per_user boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ig_comment_automations_channel
  ON instagram_comment_automations (account_id, channel_id);

-- 2) Log + dedup dos comentários processados.
CREATE TABLE IF NOT EXISTS instagram_comment_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  comment_id text NOT NULL,
  commenter_igsid text,
  commenter_username text,
  media_id text,
  comment_text text,
  automation_id uuid REFERENCES instagram_comment_automations(id) ON DELETE SET NULL,
  matched boolean NOT NULL DEFAULT false,
  public_replied boolean NOT NULL DEFAULT false,
  dm_sent boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- dedup: cada comentário é processado UMA vez por canal.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ig_comment_event
  ON instagram_comment_events (channel_id, comment_id);

-- lookup "essa pessoa já recebeu o DM dessa regra?" (once_per_user).
CREATE INDEX IF NOT EXISTS idx_ig_comment_events_user
  ON instagram_comment_events (automation_id, commenter_igsid);

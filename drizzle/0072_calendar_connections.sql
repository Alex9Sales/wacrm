-- Conexões OAuth de calendário (Google) — tokens criptografados.
-- Uma conexão por usuário+conta Google. As agendas do Google viram linhas
-- em `calendars` (source='google') apontando p/ a conexão via connection_id.
CREATE TABLE IF NOT EXISTS calendar_connections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google',
  google_email text,
  access_token text NOT NULL,   -- criptografado
  refresh_token text,           -- criptografado
  token_expiry timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_connections_provider_check CHECK (provider IN ('google'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_connections_account ON calendar_connections(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_connections_user_email
  ON calendar_connections(user_id, google_email);

-- Liga uma agenda do Google à sua conexão (p/ saber com qual token sincronizar).
ALTER TABLE calendars
  ADD COLUMN IF NOT EXISTS connection_id uuid REFERENCES calendar_connections(id) ON DELETE CASCADE;

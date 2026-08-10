-- Agenda do CRM (seção Agenda). Multi-calendário por conta/usuário; eventos
-- com vínculo opcional a contato/negócio. O sync com Google entra depois
-- (tabela de conexões numa migração seguinte); aqui é a base interna.

-- Agendas (multi): cada usuário pode ter várias; source distingue local × google.
CREATE TABLE IF NOT EXISTS calendars (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#6366f1',
  source text NOT NULL DEFAULT 'local',
  google_calendar_id text,
  is_visible boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendars_source_check CHECK (source IN ('local','google'))
);
CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars(account_id);
CREATE INDEX IF NOT EXISTS idx_calendars_owner ON calendars(owner_user_id);

-- Eventos.
CREATE TABLE IF NOT EXISTS calendar_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  calendar_id uuid NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES "user"(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  location text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id uuid REFERENCES deals(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'confirmed',
  source text NOT NULL DEFAULT 'local',
  google_event_id text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calendar_events_status_check CHECK (status IN ('confirmed','cancelled')),
  CONSTRAINT calendar_events_source_check CHECK (source IN ('local','google'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events(starts_at);
CREATE INDEX IF NOT EXISTS idx_calendar_events_contact ON calendar_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_deal ON calendar_events(deal_id);

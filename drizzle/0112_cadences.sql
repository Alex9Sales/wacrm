-- ============================================================
-- Cadências (construtor de sequência de mensagens fixas, multicanal).
-- Cada CADÊNCIA (reutilizável, por serviço/produto) tem DEGRAUS {quando, canal,
-- mensagem}. Um lead é INSCRITO (enrollment) manualmente (construtor/funil/
-- conversa); cada degrau vira uma scheduled_message (reusa o motor de envio +
-- /agendamentos). Degrau cujo canal o lead não tem → PULADO. Pausa se responder.
-- ============================================================

CREATE TABLE IF NOT EXISTS cadences (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  active boolean DEFAULT true NOT NULL,
  pause_on_reply boolean DEFAULT true NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cadences_account ON cadences (account_id);

CREATE TABLE IF NOT EXISTS cadence_steps (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  cadence_id uuid NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  position integer DEFAULT 0 NOT NULL,
  delay_value integer DEFAULT 0 NOT NULL,
  delay_unit text DEFAULT 'days' NOT NULL,   -- minutes | hours | days
  channel text DEFAULT 'whatsapp' NOT NULL,  -- whatsapp | email | instagram
  subject text,                               -- e-mail
  body text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cadence_steps_cadence ON cadence_steps (cadence_id, position);

CREATE TABLE IF NOT EXISTS cadence_enrollments (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  cadence_id uuid NOT NULL REFERENCES cadences(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid,
  deal_id uuid,
  status text DEFAULT 'active' NOT NULL,  -- active | paused | done | cancelled
  enrolled_by uuid,
  enrolled_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
-- Um lead numa cadência ativa por vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cadence_enroll_contact_active
  ON cadence_enrollments (contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_account_status ON cadence_enrollments (account_id, status);
CREATE INDEX IF NOT EXISTS idx_cadence_enroll_deal ON cadence_enrollments (deal_id);

CREATE TABLE IF NOT EXISTS cadence_events (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES cadence_enrollments(id) ON DELETE CASCADE,
  cadence_id uuid,
  contact_id uuid,
  deal_id uuid,
  type text NOT NULL,  -- enrolled | step_scheduled | step_sent | step_skipped | paused | resumed | completed | cancelled
  step_position integer,
  channel text,
  data jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cadence_events_enrollment ON cadence_events (enrollment_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cadence_events_contact ON cadence_events (contact_id, created_at DESC);

-- Tag na scheduled_message: qual inscrição/degrau a gerou (distingue de agendada
-- manual em /agendamentos + permite bulk-cancel + marcar enviado no worker).
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS cadence_enrollment_id uuid
  REFERENCES cadence_enrollments(id) ON DELETE SET NULL;
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS cadence_step_position integer;
-- Assunto (e-mail): a agendada de um degrau de e-mail leva o assunto do degrau.
-- WhatsApp/Instagram ignoram. Passado no envio via SendOptions.subject.
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS subject text;
CREATE INDEX IF NOT EXISTS idx_scheduled_cadence_enrollment
  ON scheduled_messages (cadence_enrollment_id) WHERE cadence_enrollment_id IS NOT NULL;

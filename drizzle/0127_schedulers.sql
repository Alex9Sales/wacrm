-- ============================================================
-- Página de agendamento pública (tipo Calendly): cada "scheduler" é um link
-- /agendar/<slug> onde o lead escolhe dia/horário dentro das janelas semanais
-- do dono. Ao agendar: evento na agenda (com espelho no Google se conectado) +
-- lead no funil (ingestLead, atribuído ao dono) + confirmação no WhatsApp
-- (opcional). availability = [{open,close} x7] (índice 0=domingo, formato do
-- businessDays), avaliada no fuso da conta.
-- ============================================================

CREATE TABLE IF NOT EXISTS schedulers (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  headline text,
  description text,
  user_id uuid NOT NULL,
  duration_minutes integer DEFAULT 30 NOT NULL,
  availability jsonb DEFAULT '[]'::jsonb NOT NULL,
  min_notice_hours integer DEFAULT 12 NOT NULL,
  horizon_days integer DEFAULT 14 NOT NULL,
  location text,
  pipeline_id uuid,
  stage_id uuid,
  origin text DEFAULT 'Agendamento' NOT NULL,
  confirm_whatsapp boolean DEFAULT true NOT NULL,
  confirm_channel_id uuid,
  active boolean DEFAULT true NOT NULL,
  bookings integer DEFAULT 0 NOT NULL,
  created_by uuid,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedulers_slug ON schedulers (slug);
CREATE INDEX IF NOT EXISTS idx_schedulers_account ON schedulers (account_id);

-- Histórico de ligações (painel "Ligações" estilo WhatsApp).
-- Uma linha por chamada, qualquer via (waha-voip não-oficial ou Meta oficial).
-- Entrada nasce como 'missed' e é promovida a 'answered'/'rejected' quando o
-- evento call.accepted/call.rejected chega; saída nasce 'dialing' e é
-- finalizada pelo hangup do modal (answered + duração, ou missed).
CREATE TABLE IF NOT EXISTS "call_logs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL,
  "channel_id" uuid,
  "contact_id" uuid,
  -- chatId cru do peer (556…@c.us ou …@lid) ou dígitos E.164
  "peer" text NOT NULL,
  "direction" text NOT NULL CHECK (direction IN ('in','out')),
  "status" text NOT NULL CHECK (status IN ('missed','answered','rejected','dialing')),
  "provider" text NOT NULL DEFAULT 'waha',
  "external_call_id" text,
  "duration_sec" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "call_logs_account_created" ON "call_logs" ("account_id", "created_at" DESC);
-- Promoção missed→answered acha a linha pelo id externo da chamada.
CREATE UNIQUE INDEX IF NOT EXISTS "call_logs_ext" ON "call_logs" ("account_id", "external_call_id") WHERE "external_call_id" IS NOT NULL;

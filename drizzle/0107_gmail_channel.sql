-- Modo Gmail: novo provider 'gmail' (envia por SMTP com senha de app, recebe
-- por IMAP no worker). Só amplia o CHECK do provider — ver [[crmfluxia-email-canal]].
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check
  CHECK (provider = ANY (ARRAY[
    'meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text,
    'instagram'::text, 'messenger'::text, 'email'::text, 'gmail'::text
  ]));

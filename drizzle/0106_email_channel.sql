-- ============================================================
-- 0106 — Canal de E-MAIL. Libera provider='email' + índice de roteamento por
-- endereço (provider_meta->>'address', minúsculo). O webhook do e-mail acha o
-- canal pelo endereço de destino. Aplicar nos DOIS bancos.
-- ============================================================

ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check
  CHECK (provider = ANY (ARRAY['meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text, 'instagram'::text, 'messenger'::text, 'email'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS channels_email_addr
  ON channels ((lower(provider_meta->>'address'))) WHERE (provider = 'email');

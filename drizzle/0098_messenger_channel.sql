-- Canal Facebook Messenger (DM da Página). Mesma Messenger Platform do
-- Instagram; roteamento do webhook por provider_meta->>'page_id'.

-- 1) libera provider='messenger' no CHECK.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check
  CHECK (provider = ANY (ARRAY['meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text, 'instagram'::text, 'messenger'::text]));

-- 2) roteamento do webhook: acha o canal Messenger por provider_meta->>'page_id'
--    (análogo ao channels_ig_id do Instagram).
CREATE UNIQUE INDEX IF NOT EXISTS channels_page_id
  ON channels ((provider_meta->>'page_id')) WHERE provider = 'messenger';

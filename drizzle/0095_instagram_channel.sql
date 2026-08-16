-- Canal Instagram Direct (DM). O IG identifica o usuário por IGSID (id opaco),
-- não por telefone → guardamos o IGSID em contacts.external_id (molde do isGroup,
-- que usa phone p/ id não-telefônico). Roteamento do canal por provider_meta->>'ig_id'.

-- 1) libera provider='instagram' no CHECK.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check
  CHECK (provider = ANY (ARRAY['meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text, 'instagram'::text]));

-- 2) id externo do contato (IGSID p/ Instagram; genérico p/ futuros canais sem telefone).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS external_id text;

-- 3) unicidade + lookup do contato por (conta, id externo).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_external_id
  ON contacts (account_id, external_id) WHERE external_id IS NOT NULL;

-- 4) roteamento do webhook: acha o canal IG por provider_meta->>'ig_id' (análogo
--    ao channels_meta_pnid do WhatsApp).
CREATE UNIQUE INDEX IF NOT EXISTS channels_ig_id
  ON channels ((provider_meta->>'ig_id')) WHERE provider = 'instagram';

-- 📌 Canal DEDICADO a um membro (02/09, pedido do Alex): as conversas desse
-- canal só aparecem pra esse membro (admin/owner e supervisor veem tudo).
-- Pra mais de uma pessoa por canal, usa-se setor.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS dedicated_user_id uuid NULL REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dedicated_user ON channels (account_id, dedicated_user_id) WHERE dedicated_user_id IS NOT NULL;

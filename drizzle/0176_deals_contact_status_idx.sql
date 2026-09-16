-- 16/09 (Família do Gás, Toninho/Flávia): a IA passa a procurar o card ABERTO
-- do mesmo contato no funil antes de criar outro (close-actions.ts,
-- pickDealToReuse), e o `ingestLead` já fazia essa busca. `deals` não tinha
-- índice em contact_id.
--
-- Rodar nos DOIS bancos ANTES do deploy. Em produção, CONCURRENTLY à mão
-- (fora de transação):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_account_contact_status
--     ON deals (account_id, contact_id, status);
CREATE INDEX IF NOT EXISTS "idx_deals_account_contact_status"
  ON "deals" ("account_id", "contact_id", "status");

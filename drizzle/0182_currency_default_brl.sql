-- 0182 — Moeda padrão BRL (18/09/2026).
-- deals.currency e organization.default_currency nasciam 'USD' (padrão herdado
-- do upstream / Better Auth). Todo negócio criado por caminho que não informa a
-- moeda — entrada de lead (RD, Meta, TikTok, LinkedIn), API v1, importação, IA,
-- automação — virava "US$" no card do funil, e 6 contas nasceram com moeda
-- padrão USD. O FluxiaCRM só atende empresas brasileiras: nenhum USD foi
-- escolhido de propósito.
-- Backup dos ids alterados: deals_currency_usd_backup_20260918 e
-- organization_currency_usd_backup_20260918 (criados antes, fora desta migração).

ALTER TABLE "deals" ALTER COLUMN "currency" SET DEFAULT 'BRL';
ALTER TABLE "organization" ALTER COLUMN "default_currency" SET DEFAULT 'BRL';

UPDATE "deals" SET "currency" = 'BRL' WHERE "currency" = 'USD' OR "currency" IS NULL;
UPDATE "organization" SET "default_currency" = 'BRL' WHERE "default_currency" = 'USD';

-- ============================================================
-- 0101 — Asaas como gateway de pagamento da assinatura do FluxiaCRM.
-- Guarda o customer + a assinatura do Asaas na linha de billing da org. O
-- webhook /api/webhooks/asaas vira status='active' quando o pagamento confirma.
-- Aplicar nos DOIS bancos (dev crmfluxia + prod crmfluxia_prod).
-- ============================================================

ALTER TABLE organization_billing ADD COLUMN IF NOT EXISTS asaas_customer_id text;
ALTER TABLE organization_billing ADD COLUMN IF NOT EXISTS asaas_subscription_id text;

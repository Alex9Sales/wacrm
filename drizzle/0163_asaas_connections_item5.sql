-- 🧾 Item 5 do agente de cobrança (05/09): o CRM assume os avisos + duplicados.
--
-- duplicates_report: grupos de clientes DUPLICADOS no Asaas (mesmo CPF,
--   telefone ou e-mail em vários cadastros), da última verificação. Caso real
--   de hoje: Renato ×3 = 12 parcelas em dobro. Cobrar em triplo é o pior erro
--   de uma régua.
-- notifications_off_at: quando as notificações do Asaas foram desligadas em
--   massa por aqui (o cliente paga por envio no Asaas; o CRM passa a avisar).

ALTER TABLE asaas_connections
  ADD COLUMN IF NOT EXISTS duplicates_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS duplicates_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS notifications_off_at timestamptz;

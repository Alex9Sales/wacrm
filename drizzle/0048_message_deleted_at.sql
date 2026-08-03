-- Reflete no CRM quando uma mensagem é apagada no WhatsApp (revoke /
-- "apagar para todos"). O bubble mostra "Mensagem apagada"; o conteúdo
-- original fica na linha (auditoria) mas some da UI.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamptz;

-- Código(s) do cliente (Felipe/cema): as revendas de autopeças trabalham com
-- "código de cadastro" do ERP e escrevem na frente do nome. Vira um campo de
-- primeira classe no contato, MÚLTIPLO (um contato compra 2-3-4 cadastros),
-- exibido ao lado do nome, editável, exportável/importável em CSV e via API.
ALTER TABLE "contacts"
  ADD COLUMN IF NOT EXISTS "customer_codes" text[] NOT NULL DEFAULT '{}';

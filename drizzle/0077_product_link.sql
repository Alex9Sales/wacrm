-- Link do produto (agente de Vendas). Um campo opcional de URL por item do
-- catálogo (página/checkout do produto). Entra no contexto do agente pra ele
-- compartilhar o link — o WhatsApp já mostra a prévia (com imagem, se a página
-- tiver Open Graph). Idempotente.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "link_url" text;

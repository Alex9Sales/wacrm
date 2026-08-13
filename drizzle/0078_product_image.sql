-- Imagem do produto (agente de Vendas envia como ANEXO de verdade). URL pública
-- da foto (upload via /api/media/upload → MinIO). O agente manda a imagem como
-- mensagem de mídia quando fala daquele produto. Idempotente.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "image_url" text;

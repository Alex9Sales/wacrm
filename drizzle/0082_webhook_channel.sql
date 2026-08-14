-- Webhook por CANAL (como o Chatwoot): um endpoint pode escutar SÓ um canal
-- (caixa de entrada) ou TODOS (channel_id NULL). A entrega filtra por isso.
-- Idempotente. CASCADE: apagar o canal apaga os webhooks dele (sem sentido sem o canal).
ALTER TABLE "webhook_endpoints" ADD COLUMN IF NOT EXISTS "channel_id" uuid;
DO $$ BEGIN
  ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "webhook_endpoints_channel_idx" ON "webhook_endpoints" USING btree ("channel_id");

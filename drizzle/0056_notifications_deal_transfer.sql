-- Transferir lead: notificação de transferência de negócio (deep-link pro deal).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_check"
  CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text, 'broadcast_halted'::text, 'deal_transferred'::text]));
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "deal_id" uuid;
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deal_id_fkey"
    FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

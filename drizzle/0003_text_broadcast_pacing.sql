-- Humanized text broadcasts (RecebAI-style drip) on non-official channels.
-- broadcasts gain a message_kind ('template' | 'text'), the free-text body,
-- and a pacing config; template_name becomes nullable (text broadcasts have
-- no Meta template). broadcast_recipients gain the computed per-recipient
-- send slot.
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "message_kind" text DEFAULT 'template' NOT NULL;
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "body_text" text;
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "pacing" jsonb;
--> statement-breakpoint
ALTER TABLE "broadcasts" ALTER COLUMN "template_name" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN IF NOT EXISTS "scheduled_slot_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_broadcast_recipients_slot" ON "broadcast_recipients" USING btree ("scheduled_slot_at");

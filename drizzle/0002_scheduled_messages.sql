-- Scheduled messages: a single WhatsApp message queued to be sent into ONE
-- conversation at a future time (inbox "Agendar mensagem"). Fired by a BullMQ
-- delayed job; the worker calls sendMessageToConversation at scheduled_at.
CREATE TABLE IF NOT EXISTS "scheduled_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid,
	"message_type" text DEFAULT 'text' NOT NULL,
	"content_text" text,
	"media_url" text,
	"filename" text,
	"scheduled_at" timestamptz NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_message_id" uuid,
	"external_message_id" text,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_messages_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text, 'failed'::text]))
);
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_messages_conversation" ON "scheduled_messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_messages_account_status" ON "scheduled_messages" USING btree ("account_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduled_messages_due" ON "scheduled_messages" USING btree ("scheduled_at");

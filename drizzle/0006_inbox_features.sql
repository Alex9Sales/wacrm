-- Inbox feature batch:
--   * messages.transcription  — speech-to-text of inbound audio/voice
--   * messages.view_once      — WhatsApp "view once" media (kept re-openable)
--   * account_settings        — per-account workspace toggles (agent signature)

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "transcription" text;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "view_once" boolean DEFAULT false NOT NULL;

CREATE TABLE IF NOT EXISTS "account_settings" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_settings_account_id_fkey"
		FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade
);

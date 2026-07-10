-- Quick replies (respostas rápidas) — canned messages inserted in the composer.
CREATE TABLE IF NOT EXISTS "quick_replies" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"shortcut" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quick_replies_account_id_fkey"
		FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "idx_quick_replies_account" ON "quick_replies" USING btree ("account_id");
CREATE UNIQUE INDEX IF NOT EXISTS "quick_replies_account_shortcut" ON "quick_replies" USING btree ("account_id", lower("shortcut"));

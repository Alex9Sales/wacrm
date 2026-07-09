-- Sectors (departments) — routing + privacy for conversations.

CREATE TABLE IF NOT EXISTS "sectors" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6d4bd8' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sectors_account_id_fkey"
		FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "idx_sectors_account" ON "sectors" USING btree ("account_id");

CREATE TABLE IF NOT EXISTS "sector_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"sector_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sector_members_sector_id_fkey"
		FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "sector_members_unique" ON "sector_members" USING btree ("sector_id","user_id");
CREATE INDEX IF NOT EXISTS "idx_sector_members_user" ON "sector_members" USING btree ("user_id");

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "sector_id" uuid;
CREATE INDEX IF NOT EXISTS "idx_conversations_sector" ON "conversations" USING btree ("sector_id") WHERE "sector_id" IS NOT NULL;

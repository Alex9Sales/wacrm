-- Phase 2 routing: per-channel default sector, per-sector keywords + auto-assign.

ALTER TABLE "sectors"
	ADD COLUMN IF NOT EXISTS "keywords" text[] DEFAULT ARRAY[]::text[] NOT NULL;
ALTER TABLE "sectors"
	ADD COLUMN IF NOT EXISTS "auto_assign" boolean DEFAULT true NOT NULL;

ALTER TABLE "channels"
	ADD COLUMN IF NOT EXISTS "default_sector_id" uuid;

DO $$ BEGIN
	ALTER TABLE "channels"
		ADD CONSTRAINT "channels_default_sector_id_fkey"
		FOREIGN KEY ("default_sector_id") REFERENCES "sectors"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

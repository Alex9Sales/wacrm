-- Optional media attachment for humanized text broadcasts.
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "media_url" text;
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "media_type" text;
--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "media_filename" text;

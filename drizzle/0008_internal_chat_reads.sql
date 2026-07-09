-- Per-user read state for internal chat channels (unread badge).
CREATE TABLE IF NOT EXISTS "internal_channel_reads" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_channel_reads_channel_id_fkey"
		FOREIGN KEY ("channel_id") REFERENCES "internal_channels"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "internal_channel_reads_unique" ON "internal_channel_reads" USING btree ("channel_id","user_id");

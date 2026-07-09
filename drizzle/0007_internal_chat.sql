-- Internal team chat (Chat Interno): channels + members + messages.

CREATE TABLE IF NOT EXISTS "internal_channels" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_channels_account_id_fkey"
		FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "idx_internal_channels_account" ON "internal_channels" USING btree ("account_id");

CREATE TABLE IF NOT EXISTS "internal_channel_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_channel_members_channel_id_fkey"
		FOREIGN KEY ("channel_id") REFERENCES "internal_channels"("id") ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS "internal_channel_members_unique" ON "internal_channel_members" USING btree ("channel_id","user_id");

CREATE TABLE IF NOT EXISTS "internal_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"channel_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_messages_channel_id_fkey"
		FOREIGN KEY ("channel_id") REFERENCES "internal_channels"("id") ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS "idx_internal_messages_channel" ON "internal_messages" USING btree ("channel_id","created_at");

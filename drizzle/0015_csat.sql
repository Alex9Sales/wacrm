-- CSAT (pesquisa de satisfação) — score sent by the customer after a
-- conversation is closed. `conversations.csat_pending_at` marks a thread that
-- was surveyed and is awaiting the customer's 1–5 reply.

CREATE TABLE IF NOT EXISTS "csat_responses" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
	"account_id" uuid NOT NULL,
	"conversation_id" uuid,
	"contact_id" uuid,
	"agent_id" uuid,
	"score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csat_responses_score_check" CHECK ("score" >= 1 AND "score" <= 5),
	CONSTRAINT "csat_responses_account_id_fkey"
		FOREIGN KEY ("account_id") REFERENCES "organization"("id") ON DELETE cascade,
	CONSTRAINT "csat_responses_conversation_id_fkey"
		FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE set null,
	CONSTRAINT "csat_responses_contact_id_fkey"
		FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE set null
);
CREATE INDEX IF NOT EXISTS "idx_csat_account_created"
	ON "csat_responses" USING btree ("account_id", "created_at");

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "csat_pending_at" timestamp with time zone;

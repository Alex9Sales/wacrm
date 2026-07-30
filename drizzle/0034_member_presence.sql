-- Presence (Fase 3): one row per user reporting online/away + last heartbeat.
-- "offline" is DERIVED client-side from staleness (no row / stale last_seen_at),
-- so a closed tab resolves to offline without an unload write. Account-scoped
-- read; one row per user (they have one active account at a time).
CREATE TABLE IF NOT EXISTS "member_presence" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4() NOT NULL,
  "account_id" uuid NOT NULL,
  "user_id" uuid NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'online',
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "member_presence_status_check" CHECK ("status" = ANY (ARRAY['online'::text, 'away'::text]))
);
CREATE INDEX IF NOT EXISTS "idx_member_presence_account" ON "member_presence" USING btree ("account_id");

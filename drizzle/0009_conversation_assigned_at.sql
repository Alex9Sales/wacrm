-- SLA reassign: track when the current agent was assigned.
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;

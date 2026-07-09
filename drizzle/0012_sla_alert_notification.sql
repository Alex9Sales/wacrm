-- Phase 3: allow an 'sla_alert' notification type (supervisor alert for an
-- engaged conversation that breached its SLA — reassignment is skipped for
-- already-replied conversations, so we alert instead).

ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_check";
ALTER TABLE "notifications"
	ADD CONSTRAINT "notifications_type_check"
	CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text]));

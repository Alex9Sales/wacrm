-- @mentions.
--
-- Allow a third notification type, 'mention', raised when an account member is
-- @-mentioned — in an internal-chat message or (later) an internal note on a
-- customer conversation. The mentioned user gets a notification pointing at
-- the message/conversation.
--
-- Safe + non-destructive: only WIDENS the allowed set. No existing row changes
-- type, so no backfill is needed. Idempotent (DROP IF EXISTS first).

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text]));

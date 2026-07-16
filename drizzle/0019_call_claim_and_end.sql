-- Call queueing foundation.
--
-- claimed_by: which agent took the call. Claiming is an atomic
--   UPDATE ... WHERE claimed_by IS NULL, so when a call rings every agent in
--   the account (SSE fans out to all), exactly one accept wins and the rest
--   get "atendida por outro".
-- ended_at: when the call leg finished. WhatsApp allows only ONE active call
--   per number, so the webhook needs "is this channel busy right now?" —
--   answered AND ended_at IS NULL. A second caller on a busy channel gets
--   rejected with an automatic message instead of ringing into the void.

ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS claimed_by uuid;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- "Is this channel in a call right now?" — the busy check on every inbound.
CREATE INDEX IF NOT EXISTS call_logs_channel_live
  ON call_logs (channel_id)
  WHERE ended_at IS NULL;

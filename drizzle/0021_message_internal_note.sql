-- Internal notes on a customer conversation.
--
-- is_internal: a message the team writes IN a conversation that the customer
-- never receives — for @mentioning a colleague ("@maria assume esse") without
-- leaving the thread. It's persisted like any message (so it shows inline in
-- the CRM history) but the send path skips it and it never goes to WhatsApp.
--
-- Safe: new column with a default, existing rows become false (a real
-- customer/agent message). No backfill needed.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

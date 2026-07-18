-- Group monitoring (Fase 1).
--
-- WhatsApp groups the operator chose to bring into the CRM. Ingestion is
-- OPT-IN per group (a busy group would flood the inbox), so only groups listed
-- in monitored_groups are ingested; everything else is dropped as before.
--
-- contacts.is_group: a "contact" that is actually a group (its phone holds the
-- group jid's digits, its name the group name). Lets the inbox mark/segment it.
--
-- Safe: new column with a default (existing contacts → false) and a new table.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS monitored_groups (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  group_jid text NOT NULL,
  group_name text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- One monitor row per (channel, group); the inbound check reads by these.
CREATE UNIQUE INDEX IF NOT EXISTS monitored_groups_unique
  ON monitored_groups (channel_id, group_jid);

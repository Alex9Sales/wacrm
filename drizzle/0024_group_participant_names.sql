-- Group participant name registry (Grupos — polimento: menções por nome).
--
-- Inside a group, a mention arrives in the text as the participant's LID/phone
-- digits (e.g. "@146089705500852"), NOT their name — WhatsApp resolves the name
-- client-side from its address book. The gows group participant list carries no
-- DisplayName, so the only name source we have is the pushName that rides along
-- every message the person sends. This table accumulates that mapping: as each
-- group message is ingested we upsert (wa_key -> name), then rewrite mentions in
-- later messages to the name ("@Guilherme Andrade"). Self-improving: someone who
-- has posted before gets resolved; a never-seen mention stays as the number,
-- exactly like WhatsApp when it doesn't know the contact.
--
-- wa_key = the jid "user" part: the LID user-part AND/OR the phone digits. We
-- store one row per key (both point at the same name) so a mention by either
-- addressing form resolves.
--
-- Best-effort cache — no FK, tiny, additive. Safe.

CREATE TABLE IF NOT EXISTS group_participant_names (
  account_id uuid NOT NULL,
  wa_key text NOT NULL,
  name text NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (account_id, wa_key)
);

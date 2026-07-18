-- Conversation participants — @mention access.
--
-- When you @mention a colleague in an internal note, the conversation may be
-- assigned to someone else (private). This grants the mentioned user access to
-- THAT conversation only — without changing its owner or sector. Mirrors
-- Chatwoot's "participants". The sector-privacy check reads this as one more
-- reason a non-admin may see a conversation.
--
-- Safe: new table, no change to existing rows.

CREATE TABLE IF NOT EXISTS conversation_participants (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_participants_unique
  ON conversation_participants (conversation_id, user_id);

-- The visibility check filters by user_id, then tests conversation membership.
CREATE INDEX IF NOT EXISTS conversation_participants_user
  ON conversation_participants (user_id);

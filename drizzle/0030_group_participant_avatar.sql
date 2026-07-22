-- Group participant avatars (Grupos — polimento: foto de cada participante).
--
-- Two additive, nullable columns so a group thread can render the SENDER's
-- profile photo next to each bubble (today only the author NAME shows, baked
-- into content_text as a "Nome: " prefix):
--
--   1) messages.author_key — GROUP messages only: the stable key of the
--      participant who sent the message (phone digits when known, else the LID
--      user-part). Same key space as group_participant_names.wa_key, so the
--      inbox can join a bubble to its author's photo. Null for 1:1 and for our
--      own (fromMe) echoes.
--
--   2) group_participant_names.avatar_url — the participant's re-hosted (MinIO)
--      profile photo, backfilled best-effort from their phone via the SAME
--      profile-picture pipeline as 1:1 contacts. Null = no photo yet / privacy
--      / only a LID is known. Attempt-once-per-null (retries on later messages).
--
-- Both are ADD COLUMN of a nullable text — metadata-only, no table rewrite,
-- no backfill. Safe and additive.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS author_key text;

ALTER TABLE group_participant_names ADD COLUMN IF NOT EXISTS avatar_url text;

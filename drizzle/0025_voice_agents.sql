-- Voice agent config per channel (IA de voz no CRM — fatia 1).
--
-- The account-wide `ai_configs` is the TEXT agent (one per account). The voice
-- agent is different: it's opt-in PER CHANNEL, with its own persona/prompt,
-- voice and "when does it answer" mode. This table holds that per-channel
-- config; the voice bridge (media plane) reads it to know, for each number,
-- whether the AI answers, with which prompt and voice.
--
--   enabled : the AI voice acts on this channel at all (default off — opt-in).
--   mode    : when it answers — 'always' or 'overflow' (only when the human is
--             busy/away). Off is expressed by enabled=false.
--
-- Reuses the account's OpenAI key (ai_configs); the ElevenLabs key stays
-- server-side for now. Additive + FK cascade on channel delete. Safe.

CREATE TABLE IF NOT EXISTS voice_agents (
  id uuid DEFAULT uuid_generate_v4() PRIMARY KEY NOT NULL,
  account_id uuid NOT NULL,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'overflow',
  system_prompt text,
  voice_id text,
  greeting text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT voice_agents_mode_check CHECK (mode = ANY (ARRAY['always'::text, 'overflow'::text]))
);

-- One voice-agent row per channel; the bridge reads by channel.
CREATE UNIQUE INDEX IF NOT EXISTS voice_agents_channel_unique
  ON voice_agents (channel_id);

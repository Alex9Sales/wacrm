-- Voice credentials per account (IA de voz — chaves do cliente).
--
-- The voice agent needs two provider keys, ONE set per account (the client
-- brings their own): ElevenLabs (the TTS voice) and OpenAI (the Realtime brain
-- — the voice path is OpenAI-Realtime-specific, so it needs an OpenAI key even
-- if the text agent uses another provider). Both stored AES-256-GCM encrypted
-- (same scheme as ai_configs.api_key). Never returned raw to the client.
--
-- Account-level (unique account_id); the per-channel persona/voice lives in
-- voice_agents. Additive, FK cascade. Safe.

CREATE TABLE IF NOT EXISTS voice_settings (
  account_id uuid PRIMARY KEY NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  elevenlabs_api_key text,
  openai_api_key text,
  updated_at timestamptz DEFAULT now() NOT NULL
);

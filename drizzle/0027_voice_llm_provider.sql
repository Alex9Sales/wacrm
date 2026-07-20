-- Voice LLM provider (IA de voz — motor do cérebro, escolhível pelo cliente).
--
-- The voice brain today is OpenAI Realtime, but the client should pick the
-- engine (and paste its key) so a future swap (Anthropic, a self-hosted Hermes,
-- etc.) needs no schema change — just a new allowed value. `openai` is the only
-- one wired to the media bridge for now; the UI marks the rest "em breve".
--
-- Additive, defaulted. Safe.

ALTER TABLE voice_settings
  ADD COLUMN IF NOT EXISTS llm_provider text NOT NULL DEFAULT 'openai';

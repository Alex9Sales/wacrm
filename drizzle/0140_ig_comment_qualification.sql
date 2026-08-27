-- 0140 — Qualificação por IA nas automações de comentário→DM (social selling).
-- Antes de mandar o DM, a IA analisa o perfil + o comentário contra os critérios;
-- não qualificado recebe só a resposta pública, sem DM.
ALTER TABLE instagram_comment_automations
  ADD COLUMN IF NOT EXISTS qualification_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualification_prompt text;

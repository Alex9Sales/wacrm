-- ============================================================
-- Landing pages de verdade na Captação: além do formulário, a página pública
-- pode ter hero (título + subtítulo + imagem), benefícios, prova social
-- (depoimentos) e cor da marca. Tudo num jsonb `content` (null = só o form).
-- ============================================================

ALTER TABLE capture_forms
  ADD COLUMN IF NOT EXISTS content jsonb;

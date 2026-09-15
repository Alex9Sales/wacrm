-- 15/09 (Alex, caso Will Santos/GoLink): botão OPCIONAL "Continuar pelo meu
-- número". O cliente escreveu pro número do Vitor, a conversa foi transferida
-- pro João, e tudo que o João respondia saía pelo WhatsApp do Vitor. O botão
-- abre a conversa com o mesmo cliente no número de quem atende.
--
-- A pergunta do Alex foi "o contexto vai ficar perdido?". Parte do contexto já
-- é do CONTATO (notas, etiquetas, negócios, histórico de compras) e atravessa
-- números sozinha. O que faltava era o vínculo entre as DUAS conversas, pra ir
-- de uma à outra num clique — nota interna não vira link.
--
-- ON DELETE SET NULL: apagar a conversa antiga não apaga a nova.
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "continued_from_conversation_id" uuid
  REFERENCES "conversations"("id") ON DELETE SET NULL;

-- Busca "esta conversa continuou em qual?" a partir da antiga.
CREATE INDEX IF NOT EXISTS "idx_conversations_continued_from"
  ON "conversations" ("continued_from_conversation_id")
  WHERE "continued_from_conversation_id" IS NOT NULL;

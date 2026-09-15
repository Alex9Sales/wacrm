-- 15/09 (conferência da revisão dos disparos): quem cria um disparo entra como
-- participante das conversas NASCIDAS dele (source='broadcast'). Esse acesso
-- não pode vencer o que vier depois: conversa marcada como privada ou
-- atribuída a outra pessoa volta a seguir a regra normal. A @menção
-- (source='mention', o padrão das linhas que já existem) segue como era;
-- 'broadcast_mentioned' = acompanhava por disparo e foi mencionado (lê como
-- menção; ao responder volta a 'broadcast'). Ver lib/inbox/mention-access.
-- Aditiva; rodar nos DOIS bancos ANTES do deploy.
ALTER TABLE "conversation_participants"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'mention';

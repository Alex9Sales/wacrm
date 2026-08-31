-- 🔒 Trava de acesso do agente (caso "agente de suporte só pra clientes",
-- Rafael 31/08): o agente só CONVERSA com contatos que têm a etiqueta
-- configurada; os demais recebem uma mensagem padrão (1x) e a IA se cala.
-- {"tagId": "<uuid>", "deniedMessage": "texto"} — vazio = sem trava.
ALTER TABLE ai_configs ADD COLUMN IF NOT EXISTS access jsonb NOT NULL DEFAULT '{}'::jsonb;

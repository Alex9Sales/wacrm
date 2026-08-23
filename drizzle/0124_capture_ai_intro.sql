-- ============================================================
-- IA no Segundo Zero (Captação): com o toggle ligado, o lead que envia o
-- formulário recebe EM SEGUNDOS a primeira mensagem no WhatsApp, escrita pela
-- IA da conta citando o que ele pediu — e o agente do canal continua a conversa
-- quando ele responder. intro_channel_id = canal de envio (null = padrão).
-- ============================================================

ALTER TABLE capture_forms
  ADD COLUMN IF NOT EXISTS ai_intro boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS intro_channel_id uuid;

-- Medidor de custo (Fase B): nova origem 'capture' pras chamadas de IA da
-- captação. Recria o CHECK com a lista atual + capture.
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_source_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_source_check CHECK (source = ANY (ARRAY[
  'inbox'::text, 'draft'::text, 'playground'::text, 'pipeline'::text,
  'flow'::text, 'deal_suggest'::text, 'vision'::text, 'transcribe'::text,
  'tts'::text, 'embeddings'::text, 'capture'::text
]));

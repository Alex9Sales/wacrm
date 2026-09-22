-- ============================================================
-- 🔀 Funil padrão POR CANAL (Alex, 22/09 — caso Dentai).
--
-- Conta com um WhatsApp por operação (Vendas da Sara, Suporte da Vitória; ou
-- as marcas da Família do Gás) quer que o negócio daquele número nasça no
-- funil daquele número. Hoje tudo que nasce SOZINHO — card da IA sem funil no
-- agente, lead de formulário/RD — cai no funil mais ANTIGO da conta, e
-- ninguém percebe porque não existe o momento de escolher.
--
-- Ordem de escolha do funil (a primeira que existir vence):
--   1. o que a chamada pedir explicitamente;
--   2. o funil do AGENTE de IA (ai_configs.pipeline_id, já existia);
--   3. ESTE campo — o funil do canal;
--   4. o funil mais antigo da conta (comportamento de sempre).
--
-- Null = nada muda para quem não configurar. Funil apagado vira NULL (SET
-- NULL), nunca quebra o canal.
-- ============================================================

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "default_pipeline_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_default_pipeline_id_fkey'
  ) THEN
    ALTER TABLE "channels"
      ADD CONSTRAINT "channels_default_pipeline_id_fkey"
      FOREIGN KEY ("default_pipeline_id") REFERENCES "pipelines"("id") ON DELETE SET NULL;
  END IF;
END
$$;

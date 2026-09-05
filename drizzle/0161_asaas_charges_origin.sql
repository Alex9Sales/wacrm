-- 🧾 Emissão de cobrança pela IA (`criar_cobranca`).
--
-- Até aqui `asaas_charges` só espelhava o que JÁ existia no Asaas (sync). Agora
-- a IA também CRIA cobrança no Asaas do cliente, durante o atendimento, depois
-- que o cliente confirmou produto e valor — e manda o link na conversa.
--
-- A cobrança emitida entra na MESMA tabela, marcada com a origem e a conversa:
-- assim ela já nasce dentro do ciclo de cobrança (se vencer, a régua pega; se
-- pagar, o webhook fecha) e dá para auditar o que a IA emitiu, de onde.

ALTER TABLE asaas_charges
  -- sync = veio do Asaas · ai = a IA criou no atendimento
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS conversation_id uuid;

CREATE INDEX IF NOT EXISTS asaas_charges_conversation_idx
  ON asaas_charges (conversation_id) WHERE conversation_id IS NOT NULL;

COMMENT ON COLUMN asaas_charges.origin IS 'sync = espelhada do Asaas · ai = criada pela IA no atendimento (criar_cobranca).';

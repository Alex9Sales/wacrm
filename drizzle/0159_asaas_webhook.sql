-- 🧾 Agente de Cobrança — FASE 4: parar de cobrar quem pagou.
--
-- Pior erro possível do produto, e o único sem desfazer: mandar cobrança para
-- quem acabou de pagar. Por isso são DUAS travas independentes:
--   1) este webhook — o Asaas avisa no instante do pagamento e a gente cancela
--      os toques pendentes daquele devedor na hora;
--   2) a reconsulta imediatamente antes de cada envio (já no ar desde a Fase 2),
--      que continua valendo se o webhook falhar, atrasar ou se perder.
--
-- Cada conexão tem o PRÓPRIO token na URL: o cliente cola uma URL por conta do
-- Asaas, e um token vazado não alcança as outras contas nem os outros clientes.

ALTER TABLE asaas_connections
  ADD COLUMN IF NOT EXISTS webhook_token text,
  -- Última vez que o Asaas chamou de verdade. É o que responde "o webhook está
  -- configurado mesmo?" sem depender do cliente lembrar se colou a URL.
  ADD COLUMN IF NOT EXISTS webhook_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS webhook_events integer NOT NULL DEFAULT 0;

-- Conexões que já existiam ganham token agora (o Alex já conectou a dele).
-- Dois UUIDs v4 concatenados = 64 hex de aleatoriedade forte, sem depender da
-- extensão pgcrypto (que não está instalada nestes bancos).
UPDATE asaas_connections
   SET webhook_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
 WHERE webhook_token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS asaas_connections_webhook_token_uidx
  ON asaas_connections (webhook_token) WHERE webhook_token IS NOT NULL;

COMMENT ON COLUMN asaas_connections.webhook_token IS 'Segredo na URL do webhook desta conexão. Um por conta do Asaas: vazar um não alcança as outras.';
COMMENT ON COLUMN asaas_connections.webhook_last_at IS 'Último evento recebido de verdade — prova que a URL foi colada no Asaas.';

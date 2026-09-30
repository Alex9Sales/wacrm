-- Qual pagamento já foi agradecido — para nunca agradecer duas vezes.
--
-- 29/09: até hoje, quando um cliente pagava a mensalidade, o webhook só ativava
-- a conta e avançava o vencimento. Ninguém agradecia. O Alex pediu o aviso.
--
-- Por que uma coluna e não `reminders_sent`: aquele é um objeto reescrito
-- inteiro a cada lembrete; guardar a trava do agradecimento ali faria um
-- lembrete futuro apagá-la, e o cliente receberia "obrigado" de novo meses
-- depois. Aqui é um id só, que só muda quando há outro pagamento.
--
-- Por que o ID e não um booleano: o mesmo boleto gera DOIS eventos no Asaas
-- (PAYMENT_CONFIRMED e, no dia seguinte, PAYMENT_RECEIVED), e o Asaas ainda
-- reenvia o mesmo evento quando desconfia da entrega. Guardando o id do
-- pagamento, o segundo evento reconhece que já agradeceu AQUELE pagamento — e o
-- pagamento do mês seguinte passa, porque o id é outro.
--
-- A escrita é um compare-and-swap (UPDATE … WHERE thanked_payment_id IS
-- DISTINCT FROM :id): só manda a mensagem quem conseguiu marcar. É a mesma
-- lição do espelho do RD, onde três notificações simultâneas viraram três
-- eventos porque ninguém deixou o banco arbitrar.
--
-- NULL = nunca agradecemos nada a este cliente.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS thanked_payment_id text;

COMMENT ON COLUMN organization_billing.thanked_payment_id IS
  'Id do último pagamento (Asaas) já agradecido. Trava contra agradecer duas vezes o MESMO pagamento — o boleto emite CONFIRMED e depois RECEIVED, e o Asaas reenvia. NULL = nunca agradecido.';

-- Id da COBRANÇA ÚNICA no Asaas — separado do id de assinatura.
--
-- 28/09: entrou com o contrato semestral. A regra, do Alex: "assinatura
-- semestral é sempre o valor total dos 6 meses; ele parcela no cartão dele, mas
-- nós recebemos o valor integral. Mesma coisa seria se fosse anual." Isso não é
-- mensalidade recorrente — é um pagamento só. No Asaas são dois objetos
-- diferentes: /subscriptions (repete) e /payments (uma vez).
--
-- Por que NÃO guardar o id da cobrança em asaas_subscription_id, que já
-- existia: quem cancela uma conta chama DELETE /subscriptions/{id}
-- (lib/admin/lifecycle.ts). Com um id de cobrança ali, o Asaas devolveria 404,
-- o admin veria "não consegui cancelar" e — o que importa — a cobrança do
-- cliente continuaria de pé sem ninguém saber. Dois tipos de objeto pedem duas
-- colunas; reaproveitar a coluna economiza uma migração e cobra um cliente
-- cancelado.
--
-- NULL = a conta não tem cobrança única (o normal: mensal usa assinatura).
-- As duas colunas são mutuamente exclusivas na prática, mas nada no banco
-- impede as duas preenchidas: uma conta pode ter migrado de um regime para o
-- outro, e apagar o id antigo perderia o rastro de quem cobrou o quê.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS asaas_payment_id text;

COMMENT ON COLUMN organization_billing.asaas_payment_id IS
  'Cobrança ÚNICA no Asaas (/payments) — contrato semestral/anual, que é pago de uma vez. Separado de asaas_subscription_id porque o cancelamento bate em endpoints diferentes.';

-- E-mail de cobrança do cliente.
--
-- 28/09 (Appia Saúde Integrada): o Rafael mandou o pacote de dados do cliente
-- — CNPJ, telefone, e-mail, endereço — e o CRM só tinha onde guardar os dois
-- primeiros. O e-mail ficou no WhatsApp, que é onde dado vai para morrer.
--
-- Por que ele importa: o Asaas EXIGE e-mail para abrir um cliente, e é para
-- ele que o boleto vai. Hoje o CRM não cria o cadastro lá (ele procura pelo
-- CPF/CNPJ e recusa quando não acha — "daqui a gente não cria cadastro no
-- escuro"), então o e-mail é o que falta para deixar de depender de alguém
-- cadastrar cliente por cliente na mão no Asaas.
--
-- Fica separado do e-mail de LOGIN de propósito: quem recebe a fatura
-- costuma ser o financeiro, não quem usa o sistema — na Appia, o login é de
-- uma pessoa e a cobrança vai para um endereço da empresa.
--
-- NULL = não informado. Nada passa a depender dele: o que já cobra hoje
-- continua cobrando.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS billing_email text;

COMMENT ON COLUMN organization_billing.billing_email IS
  'E-mail para onde vai a cobrança (boleto/nota). Separado do e-mail de login: quem paga costuma ser o financeiro, não quem usa. NULL = não informado.';

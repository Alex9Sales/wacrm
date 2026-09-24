-- Vincular a conta do CRM ao que já existe no Asaas (24/09, pedido do Alex).
--
-- Duas lacunas que apareceram ao tentar mostrar o dinheiro no /admin:
--
-- 1. `cpf_cnpj` — o formulário de assinatura do site JÁ pede e valida o
--    documento, mas ele ia direto pro Asaas e não ficava em lugar nenhum.
--    Resultado: não havia como achar o cliente no Asaas a partir do CRM (o
--    João da GoLink está lá desde 08/09 e o CRM não sabia o CPF dele).
--
-- 2. `monthly_value` — o painel calculava o MRR pelo preço de TABELA do
--    plano, e o que o cliente paga de verdade nem sempre é isso: o Renato
--    paga 6× R$ 1.298,50 pela implantação e só depois cai pro Pro; o João
--    entra a R$ 497 e passa a R$ 697 em janeiro. Valor em aberto na conta,
--    preenchido a partir do Asaas ao vincular. NULL = usa o preço do plano.
ALTER TABLE "organization_billing" ADD COLUMN IF NOT EXISTS "cpf_cnpj" text;
ALTER TABLE "organization_billing" ADD COLUMN IF NOT EXISTS "monthly_value" numeric(12, 2);

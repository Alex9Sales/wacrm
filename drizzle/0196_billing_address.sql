-- Endereço de cobrança do cliente.
--
-- 28/09: pedido do Alex junto com a cobrança da Appia — "pode colocar o
-- endereço também, quer deixar esses campos prontos. Quem tiver, já coloca.
-- Que quando a gente começar a enviar a nota fiscal, que isso vai ser mais
-- para frente, já tem tudo cadastrado."
--
-- Ou seja: NADA depende destes campos hoje. Eles existem para que, no dia em
-- que a nota fiscal entrar, os dados já estejam no CRM em vez de espalhados em
-- conversa de WhatsApp — que é onde dado vai para morrer (mesma razão do
-- billing_email, migr 0195).
--
-- Os nomes espelham os campos do Asaas de propósito, incluindo o `province`,
-- que lá significa BAIRRO e não província: tradução no meio do caminho é onde
-- endereço vira endereço errado. Quem lê a tela vê "Bairro"; quem lê a coluna
-- acha o campo do gateway sem precisar de um mapa.
--
-- Tudo NULL = não informado. O CEP guarda só dígitos (8), a UF só a sigla (2);
-- quem grava normaliza, para que a busca não dependa de máscara.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS billing_postal_code text,
  ADD COLUMN IF NOT EXISTS billing_address text,
  ADD COLUMN IF NOT EXISTS billing_address_number text,
  ADD COLUMN IF NOT EXISTS billing_complement text,
  ADD COLUMN IF NOT EXISTS billing_province text,
  ADD COLUMN IF NOT EXISTS billing_city text,
  ADD COLUMN IF NOT EXISTS billing_state text;

COMMENT ON COLUMN organization_billing.billing_postal_code IS
  'CEP, somente dígitos (8). NULL = não informado.';
COMMENT ON COLUMN organization_billing.billing_address IS
  'Logradouro (rua/avenida), sem o número.';
COMMENT ON COLUMN organization_billing.billing_address_number IS
  'Número. Texto porque existe "s/n", "123-A" e "1.234".';
COMMENT ON COLUMN organization_billing.billing_province IS
  'BAIRRO. O nome vem do campo province do Asaas, que é bairro lá — não província.';
COMMENT ON COLUMN organization_billing.billing_state IS
  'UF, 2 letras maiúsculas.';

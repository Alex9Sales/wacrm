-- Periodicidade do contrato: mensal, semestral ou anual.
--
-- 26/09: uma revendedora fechou o Fluxia para um cliente dela em SEIS MESES, e
-- o CRM não tinha onde registrar isso — só existia "valor por mês". Sem o
-- ciclo, ninguém sabe quando o cliente volta a pagar, nem que ele está preso
-- até tal data, nem por que o valor dele é menor que a tabela.
--
-- ⚠️ `monthly_value` CONTINUA SENDO POR MÊS, de propósito. É ele que alimenta
-- o MRR (lib/admin/success.ts) e o MRR é mensal por definição — gravar aqui o
-- total do semestre faria a receita recorrente inchar 6x. O ciclo diz o
-- COMPROMISSO; o valor diz quanto vale um mês dele.
--
-- NULL = contrato antigo, sem ciclo declarado. Não assume mensal: assumir
-- inventaria um compromisso que ninguém combinou.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS billing_cycle text;

ALTER TABLE organization_billing
  DROP CONSTRAINT IF EXISTS organization_billing_cycle_check;

ALTER TABLE organization_billing
  ADD CONSTRAINT organization_billing_cycle_check
  CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'semiannual', 'annual'));

COMMENT ON COLUMN organization_billing.billing_cycle IS
  'Compromisso do contrato: monthly | semiannual | annual. NULL = não declarado. O valor pago por mês fica em monthly_value — este campo NÃO muda a unidade daquele.';

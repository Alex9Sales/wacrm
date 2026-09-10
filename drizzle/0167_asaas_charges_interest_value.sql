-- 10/09 (João/GoLink): "a mensagem tem que exibir o valor total com os juros".
-- O Asaas já calcula juros + multa da cobrança vencida (`interestValue`);
-- a sincronização passa a guardar e a régua mostra ao lado do valor original.
ALTER TABLE "asaas_charges" ADD COLUMN IF NOT EXISTS "interest_value" numeric(12, 2);

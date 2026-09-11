-- 11/09 (João/GoLink): o CRM passa a avisar o cliente quando ENXERGA uma
-- cobrança nova que ele mesmo não criou (a conta desligou os avisos do Asaas,
-- então quem manda o link é o CRM).
--
-- Para isso ele precisa saber se a cobrança é NOVA DE VERDADE. `created_at` é
-- quando a NOSSA linha nasceu — numa ressincronização ou reconexão isso vira
-- "hoje" para cobrança de junho, e o aviso viraria um disparo em massa
-- (simulação de 11/09: 56 candidatas na GoLink, 37 delas de meses atrás).
-- `date_created` é a data no Asaas, que não mente.
ALTER TABLE "asaas_charges" ADD COLUMN IF NOT EXISTS "asaas_created_at" date;
CREATE INDEX IF NOT EXISTS "asaas_charges_asaas_created_at_idx" ON "asaas_charges" ("account_id", "asaas_created_at");

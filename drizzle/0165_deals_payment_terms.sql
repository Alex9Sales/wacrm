-- 💳 Condições de pagamento do negócio (pedido do Rafael, 08/09/2026).
--
-- No "Novo negócio" o valor continua opcional; o que a equipe quer registrar é
-- COMO o cliente vai pagar: à vista ou recorrente, em quantas vezes e por qual
-- meio. Selo no card, campo no detalhe, contexto pro agente — e base pra a
-- cobrança nascer certa depois (parcelas → parcelamento; recorrente → assinatura).
-- Todos opcionais; validação de valores fica em lib/pipelines/payment-terms.ts.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS payment_type text,
  ADD COLUMN IF NOT EXISTS recurrence text,
  ADD COLUMN IF NOT EXISTS installments integer,
  ADD COLUMN IF NOT EXISTS payment_method text;

COMMENT ON COLUMN deals.payment_type IS 'single (à vista) | recurring (recorrente) | null';
COMMENT ON COLUMN deals.recurrence IS 'weekly | monthly | bimonthly | quarterly | semiannual | yearly — só quando recorrente';
COMMENT ON COLUMN deals.installments IS 'Nº de parcelas (2–60) — só à vista; null = sem parcelamento';
COMMENT ON COLUMN deals.payment_method IS 'pix | boleto | credit_card | debit_card | transfer | cash | other';

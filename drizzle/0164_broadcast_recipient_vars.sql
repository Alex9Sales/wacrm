-- 🔁 "Chamar de volta" pelo mecanismo dos Disparos (06/09, pedido do Alex).
--
-- Um disparo de texto tem UM corpo com {{tokens}} do contato. A reativação
-- precisa de uma mensagem DIFERENTE por pessoa (sumiu há N dias, produto X).
-- `vars` guarda valores extras por destinatário, mesclados aos tokens do
-- contato na hora do envio — o corpo do disparo vira só "{{mensagem}}".

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS vars jsonb;

COMMENT ON COLUMN broadcast_recipients.vars IS 'Tokens extras deste destinatário ({{mensagem}} da reativação, etc.) — mesclados aos tokens do contato no envio.';

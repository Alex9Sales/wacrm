-- 🔁 Escopo da trava anti-duplicidade das ferramentas de escrita.
--
-- Caso Wellington (Família do Gás, 04/09): `criar_pedido` rodou 3× para UMA
-- venda — cartão às 17:12, Pix às 17:15 (o cliente trocou a forma de pagamento)
-- e Pix de novo às 17:23 (quando ele mandou o comprovante). O Alex teve que
-- apagar dois pedidos na mão.
--
-- A trava existia, mas comparava os ARGUMENTOS. E os argumentos mudaram de
-- verdade: a forma de pagamento (mudança real do cliente) e o endereço, que o
-- modelo redigitou diferente ("Rua Jorge Kalil Duailibi, 10" × "Rua Jorge Kalil
-- Dualib 10"). Comparar argumento nunca ia segurar isso.
--
-- A identidade de um pedido não são os argumentos: é "esta conversa já tem um
-- pedido". Então a trava passa a ser configurável POR FERRAMENTA:
--   args         → como era (default; nada muda pra quem já existe)
--   conversation → cria UMA vez por conversa na janela, aconteça o que acontecer
--   off          → sem trava (ferramenta feita pra rodar várias vezes, ex.: mover_pedido)

ALTER TABLE agent_tools
  ADD COLUMN IF NOT EXISTS dedup_scope text NOT NULL DEFAULT 'args';

ALTER TABLE agent_tools
  DROP CONSTRAINT IF EXISTS agent_tools_dedup_scope_check;
ALTER TABLE agent_tools
  ADD CONSTRAINT agent_tools_dedup_scope_check
  CHECK (dedup_scope IN ('args', 'conversation', 'off'));

COMMENT ON COLUMN agent_tools.dedup_scope IS 'Escopo da trava anti-duplicidade: args (padrão) · conversation (cria 1x por conversa) · off.';

-- 0143 — Ferramenta de escrita que, ao rodar com sucesso, também cria o CARD no
-- funil do Fluxia (automático, sem depender do modelo emitir [[CRIARCARD]]).
-- Ex.: criar_pedido da Família do Gás. O card é deduplicado por conversa
-- (createDealFromAi), então convive com o [[CRIARCARD]] do modelo sem duplicar.
ALTER TABLE agent_tools
  ADD COLUMN IF NOT EXISTS creates_deal boolean NOT NULL DEFAULT false;

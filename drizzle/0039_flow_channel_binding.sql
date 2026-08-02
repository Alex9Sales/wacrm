-- Vínculo opcional de fluxo↔canal. Antes um fluxo ativo rodava em TODOS os
-- canais/números da conta (sem como ter fluxo diferente por canal). Agora o
-- fluxo pode ser preso a um canal específico: só dispara em inbounds que chegam
-- por ELE. Permite "fluxo de suporte no número X", "financeiro no número Y",
-- Instagram etc. NULL = todos os canais (comportamento legado, sem quebra).
-- Nullable, SEM FK (igual 0037/0038): se o canal sumir, o fluxo só para de
-- casar — nenhum inbound tem esse channel_id — em vez de virar "todos" por SET NULL.
ALTER TABLE "flows" ADD COLUMN IF NOT EXISTS "channel_id" uuid;

-- Transferência para humano ([[HANDOFF]]) PAUSA a IA em vez de desligá-la de vez.
--
-- 29/09/2026 (reunião, caso Zelo). Até aqui, quando a IA pedia um humano, o
-- código gravava ai_autoreply_disabled = true e a IA nunca mais voltava naquela
-- conversa. A IA transferiu, o dono marcou a reunião à mão pelo WhatsApp e o
-- card nunca andou: sem a IA na conversa, ninguém emitia os marcadores que
-- mexem no funil. Decisão: a IA fica quieta N minutos e volta sozinha — se a
-- pessoa escrever e ninguém tiver respondido.
--
-- Por que uma coluna nova e não human_present_until: o único escritor dela (o
-- inbox, a cada tecla do atendente) sobrescreve sem GREATEST — a primeira
-- digitada depois da transferência encurtaria a pausa para segundos.
--
-- conversations.ai_paused_until     até quando a IA fica calada nesta conversa.
--                                   NULL (o normal) ou no passado = não pausada.
--                                   Religar a IA à mão (inbox, "devolver para a
--                                   IA", API v1) limpa de volta para NULL.
-- ai_configs.handoff_pause_minutes  quanto pausar ao pedir um humano. 0 = desliga
--                                   de vez, como era antes (padrão: nenhum agente
--                                   muda de comportamento sem alguém escolher).
--                                   Perda, lead que vai para outro funil e a 2ª
--                                   transferência em 24h sempre desligam — ver
--                                   src/lib/ai/handoff-pause.ts.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused_until timestamptz;

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_pause_minutes integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN conversations.ai_paused_until IS
  'IA calada nesta conversa até este instante (pausa pós-transferência para humano). NULL = não pausada. Ver src/lib/ai/handoff-pause.ts.';
COMMENT ON COLUMN ai_configs.handoff_pause_minutes IS
  'Ao pedir um humano ([[HANDOFF]]), pausar a IA por N minutos (0 = desligar na conversa, como antes). Limite 0–1440.';

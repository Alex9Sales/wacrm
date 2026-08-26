-- 🔀 Roteamento multiagente no MESMO canal (ideia ChatGPT/Alex 26/08):
-- a conversa tem UM agente de IA "dono" por vez. NULL = resolve pelo canal
-- (comportamento de sempre). Um agente com a ferramenta route_agent pode
-- transferir a conversa pra outro agente ([[AGENTE:nome | resumo]]),
-- preservando todo o contexto — mesmo número, sem o cliente perceber.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_agent_id uuid;

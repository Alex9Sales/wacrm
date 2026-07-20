-- Voice agent order pipeline (IA de voz — fatia 4b, criar/mover pedido no Funil).
--
-- Which Funil (pipeline) the voice AI drops orders into. A closed order becomes
-- a card in the pipeline's first stage ("Novo Pedido"); no-sale outcomes go to
-- Interessado / Cancelado / Nao Quiz (matched by stage name). Per channel,
-- optional. Additive. Safe.

ALTER TABLE voice_agents ADD COLUMN IF NOT EXISTS pipeline_id uuid;

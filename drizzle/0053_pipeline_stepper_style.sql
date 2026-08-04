-- Estilo da barra de etapas do funil na tela de detalhe: 'pills' (pílulas,
-- padrão) ou 'chevrons' (setas conectadas, estilo RD). Escolhido em Gerenciar
-- funil, com prévia.
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "stepper_style" text NOT NULL DEFAULT 'pills';

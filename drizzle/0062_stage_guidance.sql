-- Orientações por etapa (estilo RD): objetivo + descrição/orientação por etapa
-- do funil. Editável em Config do funil, exibido num painel no detalhe do negócio.
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS objective text;
ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS guidance text;

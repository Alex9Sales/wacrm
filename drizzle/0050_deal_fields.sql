-- Campos extras do lead no funil (estilo RD): temperatura (frio/morno/quente),
-- fonte (de onde veio o lead) e origem (campanha/canal). Texto livre —
-- validação e opções ficam no app.
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "temperature" text;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "source" text;
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "origin" text;

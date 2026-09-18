-- 0183 — Compromisso "Disponível" não ocupa a agenda (18/09/2026).
-- O Google marca cada evento como Ocupado (transparency opaque, o padrão) ou
-- Disponível (transparent). A importação ignorava isso: um evento de dia inteiro
-- do dono de uma conta, marcado como Disponível, entrou como ocupado e a IA
-- recusou a terça inteira para uma lead.
-- A próxima sincronização (5 min) preenche o valor certo de cada evento do
-- Google; eventos criados no CRM continuam ocupando (padrão true).

ALTER TABLE "calendar_events" ADD COLUMN IF NOT EXISTS "busy" boolean DEFAULT true NOT NULL;

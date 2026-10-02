-- 0206 — Lembrete: moveu e VOLTOU não manda de novo (02/10/2026).
--
-- `reminders_sent` conta os degraus de lembrete que já saíram para o início do
-- compromisso. Quando o início muda, ele é ZERADO (a data nova precisa dos
-- avisos dela) — no salvar da Agenda, no import do Google e no mover do
-- [[AGENDAR]] da IA. Mas a recepção que mudava 10h→11h e logo desfazia
-- 11h→10h (ou o Google, ou a IA) zerava duas vezes: o lembrete das 10h, que o
-- paciente já tinha recebido, saía DE NOVO.
--
-- Agora, ao mudar o início, o contador que valia para o início antigo fica
-- guardado aqui (só se havia degrau gasto). Voltar a um início igual, no
-- minuto, ao guardado restaura o contador (o maior entre o atual e o
-- guardado) em vez de zerar. Uma vaga só: o último início com degrau gasto.
-- A regra mora numa função só: recomecoDoLembrete
-- (src/lib/ai/meeting-reminder-block.ts).
--
--   reminders_prev_starts_at  para qual início o contador guardado vale.
--                             NULL = nada guardado.
--   reminders_prev_sent       quantos degraus já tinham saído para ele.
--                             0 = nada guardado.
--
-- Coluna com DEFAULT constante: no Postgres 11+ não reescreve a tabela.
-- Idempotente: rodar em crmfluxia e crmfluxia_prod ANTES do deploy. O Drizzle
-- põe TODAS as colunas do schema no INSERT (as que faltam vão como DEFAULT):
-- com o código novo e o banco sem estas colunas, criar compromisso quebra.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS reminders_prev_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminders_prev_sent integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN calendar_events.reminders_prev_starts_at IS
  'Para qual início vale reminders_prev_sent (02/10). NULL = nada guardado. Ver src/lib/ai/meeting-reminder-block.ts (recomecoDoLembrete).';

COMMENT ON COLUMN calendar_events.reminders_prev_sent IS
  'Degraus de lembrete que já tinham saído para reminders_prev_starts_at. Voltar a esse início (no minuto) restaura o contador em vez de zerar.';

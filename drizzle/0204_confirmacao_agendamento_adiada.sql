-- 0204 — Confirmação ao agendar ADIADA: espera alguns minutos e manda só a
-- versão final (02/10/2026).
--
-- Desde 01/10 a Agenda manda ao paciente "sua consulta está confirmada para…"
-- (opção bookingConfirmation da conta). Saía NA HORA de cada "Salvar", e nas
-- primeiras horas em produção, numa clínica odontológica:
--   - o compromisso criado no horário errado e corrigido em seguida mandou três
--     mensagens seguidas ao paciente ("confirmada às 18h", "remarcada para
--     18h30", outra);
--   - o modal abria com a agenda da dona da clínica já escolhida, a confirmação
--     saiu "com a Dra." errada e a troca de agenda depois não avisou ninguém.
--
-- Agora o salvar só põe na fila (lib/agenda/confirmacao-fila.ts): a confirmação
-- sai uns minutos depois do ÚLTIMO salvar, pelo worker booking-confirmation, com
-- o estado final comparado ao que o paciente já sabe. Salvou três vezes → sai
-- uma mensagem só, a certa.
--
--   confirmation_due_at           quando sai. NULL = nada pendente. Enquanto o
--                                 worker envia, guarda o "lease" (agora + 10 min)
--                                 e o fim compara com ele (compare-and-swap): se
--                                 a recepção salvou de novo no meio, o pendente
--                                 novo fica e sai depois.
--   confirmation_conversation_id  a conversa de onde clicaram "Agendar" (a
--                                 confirmação sai por ela, se ainda for do
--                                 paciente). Sem FK de propósito: conversa
--                                 apagada só faz o envio cair na mais recente.
--   confirmation_known            o que o paciente JÁ SABE: {startsAt,
--                                 calendarId, contactId}. NULL = nada.
--   confirmation_result           o último desfecho, para a tela: {status:
--                                 'enviada'|'naoEnviada'|'incerta'|'semMudanca'|
--                                 'descartada', motivo?, at}.
--
-- Os lembretes de consulta (lib/ai/followup.ts) PULAM o compromisso com
-- confirmação recém-pendente, para o lembrete não passar na frente dela.
--
-- Idempotente: pode rodar de novo (dev `crmfluxia` e prod `crmfluxia_prod`).

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS confirmation_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmation_conversation_id uuid,
  ADD COLUMN IF NOT EXISTS confirmation_known jsonb,
  ADD COLUMN IF NOT EXISTS confirmation_result jsonb;

-- O worker (tick de 30 s) só lê as pendentes: quase todas as linhas são NULL.
CREATE INDEX IF NOT EXISTS idx_calendar_events_confirmation_due
  ON calendar_events (confirmation_due_at)
  WHERE confirmation_due_at IS NOT NULL;

COMMENT ON COLUMN calendar_events.confirmation_due_at IS
  'Quando a confirmação ao paciente sai (fila, 02/10). NULL = nada pendente. Ver src/lib/agenda/confirmacao-fila.ts.';

COMMENT ON COLUMN calendar_events.confirmation_conversation_id IS
  'Conversa de onde clicaram Agendar: a confirmação da fila sai por ela, se ainda for do paciente.';

COMMENT ON COLUMN calendar_events.confirmation_known IS
  'O que o paciente já sabe da consulta: {startsAt, calendarId, contactId}. NULL = nada (marcação).';

COMMENT ON COLUMN calendar_events.confirmation_result IS
  'Último desfecho da confirmação, para a tela: {status, motivo?, at}.';

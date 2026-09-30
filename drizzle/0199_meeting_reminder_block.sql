-- Por que o lembrete daquela consulta não saiu — escrito no próprio compromisso.
--
-- 30/09/2026. O Alex marcou uma reunião pelo CRM para testar o campo novo de
-- paciente; o lembrete não saiu e o sistema marcou como enviado assim mesmo.
-- `reminders_sent` é um contador que só anda para frente: queimar um degrau que
-- não saiu perde aquele aviso PARA SEMPRE, e ninguém fica sabendo.
--
-- Havia seis caminhos que queimavam o degrau sem mandar mensagem (IA pausada na
-- conversa, template faltando no canal oficial, template recusado pela Meta,
-- conversa sem histórico, envio recusado pelo canal) ou que tentavam para
-- sempre em silêncio (contato sem conversa nenhuma). Só dois carimbos estavam
-- certos: o card ter saído da etapa e a própria IA concluir que não cabia
-- mensagem — esses dois não têm volta.
--
-- Agora o que é reversível SEGURA o degrau em vez de queimá-lo, e grava aqui o
-- motivo. Segurar não acumula lembrete atrasado: o sweep só tenta o degrau
-- vencido mais recente, então o preso é descartado quando o próximo vence.
--
-- Por que uma coluna e não uma tarefa: tarefa só nasce se houver card aberto e
-- se o operador tiver ligado o registro em tarefas — as duas coisas faltam
-- justamente na clínica, onde a consulta não tem card nenhum. O aviso tem que
-- morar onde a pessoa olha: no compromisso, na tela da Agenda.
--
-- NULL = nada travado (o normal). O envio bem-sucedido limpa de volta para NULL.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS reminder_block text,
  ADD COLUMN IF NOT EXISTS reminder_block_at timestamptz;

COMMENT ON COLUMN calendar_events.reminder_block IS
  'Por que o lembrete deste compromisso não conseguiu sair: sem_conversa, ia_pausada, sem_template, template_falhou, sem_historico, envio_falhou. NULL = sem impedimento. Ver src/lib/ai/meeting-reminder-block.ts.';

COMMENT ON COLUMN calendar_events.reminder_block_at IS
  'Desde quando o lembrete está travado. Limpo junto com reminder_block assim que um lembrete sai.';

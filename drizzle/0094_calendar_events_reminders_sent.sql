-- Lembretes de reunião ancorados no horário do evento (24h/12h/1h antes, +2h
-- depois, etc). Conta quantos lembretes (na ordem cronológica) já saíram pra
-- este evento — estilo o contador da tarefa do n8n. Fura só pra frente.
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS reminders_sent integer NOT NULL DEFAULT 0;

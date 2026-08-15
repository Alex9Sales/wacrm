-- IA agenda de verdade (opt-in por agente): quando a IA e o cliente combinam um
-- horário, ela cria o evento na Agenda do CRM (e espelha no Google se conectado).
ALTER TABLE "ai_configs" ADD COLUMN IF NOT EXISTS "auto_schedule_enabled" boolean DEFAULT false NOT NULL;

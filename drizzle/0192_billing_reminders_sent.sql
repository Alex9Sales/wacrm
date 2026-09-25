-- Lembrete automático da mensalidade (25/09, pedido do Alex): cinco dias
-- antes, no dia e depois do vencimento.
--
-- `last_reminder_at` já existia, mas só diz QUANDO saiu o último — não diz
-- QUAL degrau. Sem isso, um deploy no meio do dia (ou dois ticks seguidos)
-- reenviaria a mesma mensagem pro mesmo cliente. Aqui fica o registro por
-- vencimento: {"2026-10-04": [-5, 0]}. Vencimento novo começa a lista do
-- zero sozinho, sem ninguém precisar limpar nada.
ALTER TABLE "organization_billing" ADD COLUMN IF NOT EXISTS "reminders_sent" jsonb DEFAULT '{}'::jsonb NOT NULL;

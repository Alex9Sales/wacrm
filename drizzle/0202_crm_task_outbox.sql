-- 0202 — Fila de TAREFAS concluídas para o RD Station CRM (01/10/2026).
--
-- Pedido da Zelo (29/09): o time trabalha no RD e via o lead "sem nenhuma
-- tentativa" enquanto a régua do FluxiaCRM já tinha mandado três mensagens —
-- e ligava de novo, ou repetia o texto à mão. Agora cada toque de cadência
-- enviado (conta com `logCadenceTasks` ligado) vira tarefa JÁ CONCLUÍDA no
-- card daqui e, por esta fila, no negócio do RD ligado ao card.
--
-- Por que fila: quem envia o toque (worker de agendamento) não pode esperar o
-- RD nem cair por causa dele, e o card pode ainda não ter negócio no RD (o
-- espelho espera até 10 min pelo que o RD Marketing cria). O tick do espelho
-- (`drainTaskOutbox`, lib/integrations/rdcrm/sync.ts) leva pro RD quando o
-- vínculo existe; sem vínculo em 24 h, desiste e registra o motivo.
--
-- Só enfileira em conta com a integração ligada (o INSERT confere — ver
-- `enqueueRdTask` em lib/integrations/rdcrm/task-outbox.ts).
--
-- Fora do src/db/schema.ts de propósito: só o espelho lê e escreve, por SQL.

CREATE TABLE IF NOT EXISTS "crm_task_outbox" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL,
  "deal_id" uuid NOT NULL REFERENCES "deals"("id") ON DELETE CASCADE,
  -- Tarefa local que originou a linha (trava contra duplicata). Apagar a
  -- tarefa daqui não cancela o registro no RD: o toque saiu do mesmo jeito.
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,                              -- 'whatsapp' | 'email' (= type da tarefa no RD)
  "subject" text NOT NULL,
  "notes" text,
  "done_at" timestamptz NOT NULL,                    -- data/hora da tarefa no RD (fuso da conta)
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,                        -- NULL = pendente
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,                                 -- por que não foi (ou desistiu)
  "external_id" text                                 -- id da tarefa no RD
);

-- Mesma tarefa local entra uma vez só (toque reprocessado não duplica no RD).
CREATE UNIQUE INDEX IF NOT EXISTS "crm_task_outbox_task_key"
  ON "crm_task_outbox" ("task_id") WHERE "task_id" IS NOT NULL;

-- O tick só lê as pendentes.
CREATE INDEX IF NOT EXISTS "idx_crm_task_outbox_pending"
  ON "crm_task_outbox" ("processed_at", "created_at") WHERE "processed_at" IS NULL;

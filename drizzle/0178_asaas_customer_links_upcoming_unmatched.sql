-- 16/09 (Veloz Gás e Água, GoLink): parcela A VENCER de cliente do Asaas que
-- não casava com nenhum contato do CRM era invisível. O lembrete pulava
-- ("no_contact") e só o log do worker sabia — o log se perdeu quando o
-- container foi recriado. E não havia vínculo durável "cliente do Asaas →
-- contato": a ligação feita à mão na carteira valia só para as cobranças já
-- espelhadas, e a PRÓXIMA parcela era casada de novo por palpite (Ótica Exemplo
-- ficou dividida em dois contatos, cobrada em 11/09 por WhatsApp e em 14/09
-- por e-mail).
--
-- Duas tabelas, porque o retrato é refeito a cada rodada e o vínculo é decisão
-- de uma pessoa (limpar um não pode apagar o outro):
--   • asaas_customer_links — "este cliente do Asaas é este contato". Só nasce
--     por clique. Vence o casamento automático no lembrete e na sincronização.
--   • collections_upcoming_unmatched — quem vence na janela do lembrete e não
--     casou (sem contato ou mais de um contato). A tela /cobrancas mostra.
--
-- Chave (conta, conexão, cliente): o cus_ é por conta do Asaas, e a GoLink tem
-- duas.
--
-- Só DDL, aditiva. SEM vínculo retroativo aqui: o INSERT das ligações manuais
-- antigas prenderia R&S Vidros e Ótica Exemplo a contatos SEM telefone (a
-- cobrança da Ótica Exemplo pararia de sair por WhatsApp). Se um dia for feito,
-- é script à parte, com dry-run, depois de a equipe resolver esses dois.
--
-- Rodar nos DOIS bancos (crmfluxia e crmfluxia_prod) ANTES do deploy: a
-- sincronização e o lembrete passam a ler asaas_customer_links (com fallback
-- para o casamento automático se falhar), e as ações da tela precisam dela.
CREATE TABLE IF NOT EXISTS "asaas_customer_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "asaas_connections"("id") ON DELETE CASCADE,
  "asaas_customer_id" text NOT NULL,
  "contact_id" uuid NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "linked_by" uuid,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "asaas_customer_links_customer_uidx"
  ON "asaas_customer_links" ("account_id", "connection_id", "asaas_customer_id");
CREATE INDEX IF NOT EXISTS "asaas_customer_links_contact_idx"
  ON "asaas_customer_links" ("account_id", "contact_id");

CREATE TABLE IF NOT EXISTS "collections_upcoming_unmatched" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "asaas_connections"("id") ON DELETE CASCADE,
  "asaas_customer_id" text NOT NULL,
  "customer_name" text,
  "phone" text,
  "email" text,
  "cpf_cnpj" text,
  "reason" text NOT NULL,
  -- [{ id, value, dueDate, invoiceUrl, description }] em ordem de vencimento.
  -- A tela filtra por estas datas (não pela menor): a de ontem venceu, a de
  -- amanhã continua.
  "payments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "next_due_date" date,
  "total" numeric(12, 2) DEFAULT '0' NOT NULL,
  "first_seen_at" timestamptz DEFAULT now() NOT NULL,
  "last_seen_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "collections_upcoming_unmatched_reason_check" CHECK ("reason" IN ('no_contact', 'ambiguous'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "collections_upcoming_unmatched_customer_uidx"
  ON "collections_upcoming_unmatched" ("account_id", "connection_id", "asaas_customer_id");
CREATE INDEX IF NOT EXISTS "collections_upcoming_unmatched_due_idx"
  ON "collections_upcoming_unmatched" ("account_id", "next_due_date");

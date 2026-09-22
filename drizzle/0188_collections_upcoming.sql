-- ============================================================
-- 🔔 Próximos vencimentos — as parcelas A VENCER, de TODO mundo, gravadas.
--
-- João/GoLink, 21/09: "entrei no Fluxia e não achei uma cliente". A parcela
-- dela ainda não tinha vencido, e o CRM só guarda cobrança VENCIDA em
-- asaas_charges. A varredura do lembrete (scanUpcoming) lia as a vencer ao
-- vivo no Asaas, usava para enfileirar o lembrete e DESCARTAVA — só quem não
-- tinha contato ia para collections_upcoming_unmatched. Não existia lugar
-- nenhum para ver "o que vence essa semana".
--
-- Tabela própria, e não asaas_charges: 14+ consumidores (carteira, cartões,
-- portões da IA, webhook de pagamento, fila da régua) tratam `open=true` como
-- "vencida"; gravar a vencer lá contaminaria todos de uma vez.
--
-- Uma linha por parcela (asaas_id), horizonte de 30 dias, refeita a cada
-- rodada: o que sumiu (pagou, venceu e virou carteira, saiu da janela) é
-- apagado pela própria varredura. contact_id é o casamento da hora (vínculo
-- manual > telefone/e-mail/documento); null = sem contato no CRM.
--
-- Rodar nos DOIS bancos (crmfluxia e crmfluxia_prod) ANTES do deploy.
-- ============================================================

CREATE TABLE IF NOT EXISTS "collections_upcoming" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "asaas_connections"("id") ON DELETE CASCADE,
  -- pay_… do Asaas: uma linha por parcela.
  "asaas_id" text NOT NULL,
  "asaas_customer_id" text NOT NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "customer_name" text,
  "phone" text,
  "email" text,
  "cpf_cnpj" text,
  "value" numeric(12, 2) DEFAULT '0' NOT NULL,
  "due_date" date,
  "invoice_url" text,
  "description" text,
  "first_seen_at" timestamptz DEFAULT now() NOT NULL,
  -- Início da leitura que viu esta parcela — a limpeza apaga o que é mais velho.
  "last_seen_at" timestamptz DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "collections_upcoming_asaas_uidx"
  ON "collections_upcoming" ("account_id", "asaas_id");
CREATE INDEX IF NOT EXISTS "collections_upcoming_due_idx"
  ON "collections_upcoming" ("account_id", "due_date");
CREATE INDEX IF NOT EXISTS "collections_upcoming_contact_idx"
  ON "collections_upcoming" ("account_id", "contact_id");

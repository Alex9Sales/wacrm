-- 15/09 (GoLink/Vale Ouro): o Gmail devolveu a cobrança de 14/09
-- (taubate@valeouro.com.br — domínio com Null MX, 5.1.10) e a devolução virou
-- um contato "Mail Delivery Subsystem" com conversa aberta. A régua ia mandar
-- de novo pro mesmo endereço em 17/09.
--
-- Supressão POR ENDEREÇO (não por contato): o mesmo e-mail pode estar em mais
-- de um contato, e a régua também usa o e-mail que vem do Asaas
-- (asaas_charges.email). Nunca apagar contacts.email nem asaas_charges.email:
-- o sync do Asaas regrava e usa o e-mail pra casar cliente.
--
-- Só entra aqui devolução PERMANENTE (5.x.x) que casou com um envio nosso.
-- cleared_at = alguém liberou o endereço de novo (fica o histórico).
CREATE TABLE IF NOT EXISTS "email_bounces" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "account_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "address" text NOT NULL,
  "contact_id" uuid REFERENCES "contacts"("id") ON DELETE SET NULL,
  "channel_id" uuid REFERENCES "channels"("id") ON DELETE SET NULL,
  "message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
  "status_code" text,
  "diagnostic" text,
  "bounce_count" integer NOT NULL DEFAULT 1,
  "first_bounced_at" timestamptz NOT NULL DEFAULT now(),
  "last_bounced_at" timestamptz NOT NULL DEFAULT now(),
  "cleared_at" timestamptz,
  "cleared_by" uuid,
  CONSTRAINT "email_bounces_address_lower" CHECK ("address" = lower("address"))
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_bounces_account_address_uidx"
  ON "email_bounces" ("account_id", "address");

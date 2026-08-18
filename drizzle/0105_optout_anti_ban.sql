-- Anti-ban: opt-out / "não perturbe" nos contatos + toggle de descadastro nos
-- disparos de texto.

-- Marcador de opt-out no contato. Disparos/agendadas PULAM quem está com true.
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_out" boolean NOT NULL DEFAULT false;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_out_at" timestamptz;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "opted_out_reason" text;

-- Índice parcial: achar rápido os opt-outs da conta (skip no envio + selo na UI).
CREATE INDEX IF NOT EXISTS "idx_contacts_opted_out"
  ON "contacts" ("account_id") WHERE "opted_out";

-- Disparo de texto anexa a opção de descadastro por padrão.
ALTER TABLE "broadcasts" ADD COLUMN IF NOT EXISTS "include_opt_out" boolean NOT NULL DEFAULT true;

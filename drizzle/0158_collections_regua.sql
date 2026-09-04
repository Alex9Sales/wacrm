-- 🧾 Agente de Cobrança — FASE 2: a régua.
--
-- Estado da cobrança POR DEVEDOR (contato do CRM), que é o que a régua precisa
-- para saber quando pode tocar de novo. O ciclo, a janela de horário e o teto
-- diário são configuração em account_settings.settings.collections (jsonb), e
-- não precisam de coluna.
--
-- `snooze_until` já nasce aqui porque a régua tem que RESPEITAR a promessa do
-- cliente desde o primeiro dia; quem vai PREENCHER esse campo lendo a resposta
-- ("só tenho dia 30") é a Fase 3.

CREATE TABLE IF NOT EXISTS collections_touches (
  account_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Último toque REALMENTE entregue (não o agendado, não o sugerido).
  last_touch_at timestamptz,
  -- Toques seguidos sem o devedor responder. Zera quando ele fala.
  touch_count integer NOT NULL DEFAULT 0,
  -- Cliente prometeu pagar nesta data: a régua dorme até lá.
  snooze_until timestamptz,
  snooze_reason text,
  -- Pausa manual (acordo em andamento, caso jurídico, "não cobra esse").
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  paused_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS collections_touches_due_idx
  ON collections_touches (account_id, last_touch_at) WHERE NOT paused;

COMMENT ON TABLE collections_touches IS 'Estado da régua por devedor: quando foi o último toque, quantos já foram, até quando dorme.';
COMMENT ON COLUMN collections_touches.touch_count IS 'Toques sem resposta. No limite configurado a régua PARA e chama gente — cobrar para sempre a cada 3 dias derruba o número.';

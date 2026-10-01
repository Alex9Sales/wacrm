-- Suspensão automática por inadimplência: quando, por quê, e como pagar.
--
-- 30/09/2026. O Alex pediu a trava: não pagou e passou de 5 dias do vencimento,
-- suspende o acesso; só libera depois do pagamento, e pagou → libera na hora.
--
-- A suspensão já existia, mas só manual (/admin → "Desligar"), sem registro de
-- motivo nem de data, e a tela que o cliente via dizia apenas "fale com a
-- Fluxia" — sem link para pagar. Uma trava automática com essa tela trancaria o
-- cliente do lado de fora sem dar a ele o meio de entrar de volta.
--
-- suspended_at        quando a conta foi suspensa (NULL = não está suspensa)
-- suspend_reason      'inadimplencia' (automática) ou 'manual'. A reativação
--                     pelo pagamento limpa as três colunas.
-- suspend_invoice_url o link da fatura VENCIDA que motivou a suspensão, gravado
--                     no momento em que ela acontece. É o que a tela de conta
--                     suspensa mostra no botão "Pagar agora" — a única porta de
--                     saída que o cliente tem, já que todo o resto está trancado.

ALTER TABLE organization_billing
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspend_reason text,
  ADD COLUMN IF NOT EXISTS suspend_invoice_url text;

COMMENT ON COLUMN organization_billing.suspended_at IS
  'Quando a conta foi suspensa. NULL = não está suspensa. Limpo pelo pagamento (webhook do Asaas).';
COMMENT ON COLUMN organization_billing.suspend_reason IS
  'inadimplencia (trava automática, 6º dia de atraso) ou manual (/admin). Ver src/lib/billing/suspension.ts.';
COMMENT ON COLUMN organization_billing.suspend_invoice_url IS
  'Link da fatura vencida que motivou a suspensão — vira o botão "Pagar agora" da tela de conta suspensa.';

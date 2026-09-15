-- ============================================================
-- 2026-09-15 — Tirar ids de canais APAGADOS da lista de canais dos agentes
-- (ai_configs.auto_reply_channel_ids). NÃO foi executado. Rodar à mão, nos
-- DOIS bancos (crmfluxia e crmfluxia_prod), conferindo cada passo.
--
-- Por quê: produção (lido 15/09) tinha agentes com id de canal que não existe
-- mais — Fluxia "Agente principal" 6 ids/5 válidos; Limpeza com Zelo "Zelia"
-- 4/1; GoLink "Agente principal" 2/1 (66b04d6e…); Felipe Macedo/CEMA "Agente
-- principal" (default, ativo) 1/0.
--
-- ⚠️ REGRA: lista VAZIA num agente default = responde em TODOS os canais
-- (src/lib/ai/agents.ts pickAgentIdForChannel; inbound.ts). Então só limpa quem
-- CONTINUA com ≥1 canal válido. Quem ficaria vazio (CEMA) NÃO é mexido: hoje
-- ele não responde em canal nenhum, e esvaziar viraria "responde em todos".
-- Esse caso é do cliente escolher os canais na tela do agente (que avisa).
--
-- "Válido" = canal que existe NA MESMA CONTA do agente (é só assim que uma
-- conversa casa com o id no roteamento).
--
-- Mesma regra do DELETE /api/channels/[id] (lib/ai/agent-channels.ts
-- removeDeletedChannel), que já cuida dos canais apagados daqui pra frente.
-- ============================================================

BEGIN;

-- 0) Prévia: agentes com pelo menos 1 canal apagado na lista.
SELECT
  a.account_id,
  a.id                                        AS agent_id,
  a.name,
  a.is_default,
  a.is_active,
  cardinality(a.auto_reply_channel_ids)       AS total,
  (SELECT count(*) FROM unnest(a.auto_reply_channel_ids) AS c(cid)
    WHERE EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
  )                                           AS validos,
  CASE WHEN EXISTS (
    SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
    WHERE EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
  ) THEN 'limpa' ELSE 'NÃO MEXE (ficaria sem canal)' END AS acao
FROM ai_configs a
WHERE EXISTS (
  SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
  WHERE NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
)
ORDER BY acao, a.account_id, a.name;

-- 1) Backup de TODOS os agentes com canal apagado (inclusive os que não serão
--    mexidos). Sem IF NOT EXISTS de propósito: se a tabela já existe, o CREATE
--    falha e a transação para — nunca "pula em silêncio" com backup velho.
CREATE TABLE ai_configs_bkp_canais_apagados_20260915 AS
SELECT
  a.id,
  a.account_id,
  a.name,
  a.is_default,
  a.is_active,
  a.auto_reply_channel_ids,
  now() AS backed_up_at
FROM ai_configs a
WHERE EXISTS (
  SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
  WHERE NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
);

-- 2) Confere o backup ANTES do UPDATE: mesmo número de linhas da prévia.
DO $$
DECLARE
  n_backup int;
  n_alvo   int;
BEGIN
  SELECT count(*) INTO n_backup FROM ai_configs_bkp_canais_apagados_20260915;
  SELECT count(*) INTO n_alvo
    FROM ai_configs a
   WHERE EXISTS (
     SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
     WHERE NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
   );
  IF n_backup = 0 OR n_backup <> n_alvo THEN
    RAISE EXCEPTION 'backup com % linha(s), esperado % — abortando', n_backup, n_alvo;
  END IF;
END $$;

-- 3) Tira os ids inexistentes SÓ de quem mantém ≥1 válido (ordem preservada).
UPDATE ai_configs a
   SET auto_reply_channel_ids = ARRAY(
         SELECT c.cid
           FROM unnest(a.auto_reply_channel_ids) WITH ORDINALITY AS c(cid, ord)
          WHERE EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
          ORDER BY c.ord
       ),
       updated_at = now()
 WHERE EXISTS (
         SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
         WHERE NOT EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
       )
   AND EXISTS (
         SELECT 1 FROM unnest(a.auto_reply_channel_ids) AS c(cid)
         WHERE EXISTS (SELECT 1 FROM channels ch WHERE ch.id = c.cid AND ch.account_id = a.account_id)
       )
RETURNING a.account_id, a.id AS agent_id, a.name, cardinality(a.auto_reply_channel_ids) AS depois;

-- 4) Conferência: antes × depois. Nenhuma lista pode ter ficado VAZIA, e os
--    "NÃO MEXE" continuam iguais ao backup (sem canal válido — avisar o cliente).
SELECT
  b.account_id,
  b.id                                   AS agent_id,
  b.name,
  b.is_default,
  cardinality(b.auto_reply_channel_ids)  AS antes,
  cardinality(a.auto_reply_channel_ids)  AS depois,
  CASE
    WHEN cardinality(a.auto_reply_channel_ids) = 0 THEN '❌ FICOU VAZIA — ROLLBACK'
    WHEN a.auto_reply_channel_ids = b.auto_reply_channel_ids THEN 'mantida (sem canal válido)'
    ELSE 'limpa'
  END                                    AS resultado
FROM ai_configs_bkp_canais_apagados_20260915 b
JOIN ai_configs a ON a.id = b.id
ORDER BY resultado, b.account_id, b.name;

-- Se a conferência estiver certa:
-- COMMIT;
-- Senão:
-- ROLLBACK;

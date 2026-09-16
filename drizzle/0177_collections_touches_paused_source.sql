-- 16/09 (Guincho Ribeiro, GoLink): a pausa da régua que a IA pôs ("acordo")
-- ficou valendo para sempre depois de ele pagar tudo, invisível em qualquer
-- tela. A pausa passa a guardar QUEM pausou e QUANDO: a da IA sai sozinha
-- quando o cliente quita o que estava vencido (lib/collections/pause.ts); a da
-- equipe nunca some sozinha e aparece com "Retomar cobrança".
--
-- Aditiva. Rodar nos DOIS bancos ANTES do deploy; rodar o UPDATE de novo
-- depois do deploy (pausa gravada pelo código antigo no meio do caminho).
ALTER TABLE "collections_touches"
  ADD COLUMN IF NOT EXISTS "paused_source" text,
  ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;

-- 'resumed' = uma pessoa retomou a cobrança (paused=false, paused_at = quando):
-- a IA não pausa de novo por 7 dias (pause.ts).
ALTER TABLE "collections_touches" DROP CONSTRAINT IF EXISTS "collections_touches_paused_source_check";
ALTER TABLE "collections_touches"
  ADD CONSTRAINT "collections_touches_paused_source_check"
  CHECK ("paused_source" IS NULL OR "paused_source" IN ('human', 'ai', 'revert', 'resumed'));

-- Pausas que já existem: origem pelo motivo que cada caminho grava; "desde"
-- só dá para saber com certeza na da IA (nota 🧾 que ela deixa). updated_at
-- NÃO serve — qualquer toque, promessa ou pagamento mexe nele.
UPDATE "collections_touches" ct SET
  "paused_source" = CASE
    WHEN ct."paused_reason" IN ('Cliente pediu acordo/parcelamento', 'Cliente contesta a cobrança') THEN 'ai'
    WHEN ct."paused_reason" = 'Cobrança marcada como errada' THEN 'revert'
    ELSE 'human' END,
  "paused_at" = CASE
    WHEN ct."paused_reason" IN ('Cliente pediu acordo/parcelamento', 'Cliente contesta a cobrança') THEN (
      SELECT max(m."created_at") FROM "messages" m JOIN "conversations" cv ON cv."id" = m."conversation_id"
      WHERE cv."account_id" = ct."account_id" AND cv."contact_id" = ct."contact_id" AND m."is_internal"
        AND (m."content_text" LIKE '🧾 Cliente pediu acordo%' OR m."content_text" LIKE '🧾 Cliente contesta%'))
    ELSE NULL END
WHERE ct."paused" AND ct."paused_source" IS NULL;

-- Presença manual (Fase 3.1): o membro agora escolhe o próprio status
-- (Online / Ausente / Offline) num controle no topo. "Offline" deixa de ser
-- só derivado da defasagem — vira uma escolha EXPLÍCITA que o membro grava
-- mesmo com a aba aberta (ex.: saiu pro almoço). Relaxa o CHECK pra aceitar
-- 'offline' como valor armazenado.
ALTER TABLE "member_presence" DROP CONSTRAINT IF EXISTS "member_presence_status_check";
ALTER TABLE "member_presence" ADD CONSTRAINT "member_presence_status_check"
  CHECK ("status" = ANY (ARRAY['online'::text, 'away'::text, 'offline'::text]));

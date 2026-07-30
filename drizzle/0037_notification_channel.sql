-- Deep-link de notificação do chat interno (Felipe): uma menção num grupo/canal
-- interno precisa levar direto pro canal e mostrar QUAL canal. A tabela só tinha
-- conversation_id (inbox). Guarda o canal interno da menção. Nullable, sem FK
-- (evita cascade; o canal pode ser excluído e a notificação vira dead-link inócuo).
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "channel_id" uuid;

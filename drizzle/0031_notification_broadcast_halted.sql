-- Alerta de disparo pausado automaticamente (auto-halt).
--
-- O worker passa a PAUSAR o disparo inteiro quando o canal entra em apuros —
-- ou o WhatsApp bloqueia o número por reputação (erro 463), ou a sessão cai /
-- desloga. Continuar mandando nesses casos é o que QUEIMA o número: o 463 já
-- não re-tenta o mesmo destinatário, mas o disparo seguia para os próximos e
-- ia acumulando bloqueio (caso real 22-23/07: blast frio → WhatsApp desvinculou
-- o dispositivo e depois passou a rejeitar todo envio com 463).
--
-- Ao pausar, o dono do disparo recebe uma notificação explicando o motivo. O
-- `type` das notificações é restrito por CHECK, então só estendemos a lista com
-- 'broadcast_halted'. Nenhuma linha existente muda — é só ampliar o domínio
-- aceito (drop + recreate do CHECK, metadata-only, sem rewrite).

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'conversation_assigned'::text,
    'sla_alert'::text,
    'mention'::text,
    'broadcast_halted'::text
  ]));

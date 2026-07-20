-- Voice agent order-notification target (IA de voz — fatia 4, notificar_pedido).
--
-- When the voice AI closes an order it calls the `notificar_pedido` tool; the
-- CRM formats the order summary and sends it on WhatsApp to this number (the
-- "celular do gás" / dispatcher). Per channel, optional. Additive. Safe.

ALTER TABLE voice_agents ADD COLUMN IF NOT EXISTS notify_phone text;

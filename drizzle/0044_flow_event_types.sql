-- Fluxos: amplia os event_type aceitos no log de execuções.
--   - 'delay_sleep' já era EMITIDO pelo nó Esperar (Fase 2 Etapa 1) mas não
--     estava no CHECK → o insert falhava silencioso (logEvent engole erro) e
--     o evento sumia do log. Adiciona aqui.
--   - 'http_request' é o evento do novo nó http_fetch (Etapa 4).
ALTER TABLE "flow_run_events" DROP CONSTRAINT IF EXISTS "flow_run_events_event_type_check";
ALTER TABLE "flow_run_events" ADD CONSTRAINT "flow_run_events_event_type_check"
  CHECK (event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'delay_sleep'::text, 'http_request'::text, 'error'::text, 'completed'::text]));

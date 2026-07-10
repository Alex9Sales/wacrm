-- Let a caller suppress the assignment notification for a self-claim (an
-- agent replying to their own unassigned thread takes ownership, but should
-- NOT be notified about a conversation they're actively handling). The send
-- route sets `SET LOCAL app.suppress_assign_notify = 'on'` around that update;
-- real reassignments (manual, SLA) leave it unset and still notify.
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
BEGIN
  IF current_setting('app.suppress_assign_notify', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    NULL,
    'Nova conversa atribuída',
    'Você recebeu uma conversa com '
      || COALESCE(v_contact_name, 'um contato')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

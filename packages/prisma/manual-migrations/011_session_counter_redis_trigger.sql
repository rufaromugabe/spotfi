-- Trigger to notify Redis about session count changes
-- Sends pg_notify when sessions start (INSERT) or stop (UPDATE acctstoptime)
-- The application listens to these notifications and updates Redis counters

CREATE OR REPLACE FUNCTION notify_session_count_change()
RETURNS TRIGGER AS $$
DECLARE
  username_val TEXT;
  action TEXT;
BEGIN
  -- Determine username and action
  IF TG_OP = 'INSERT' THEN
    username_val := NEW.username;
    action := 'start';
    
    -- Only notify if session is active (no stop time)
    IF NEW.acctstoptime IS NULL THEN
      PERFORM pg_notify('session_count_change', json_build_object(
        'username', username_val,
        'action', action
      )::text);
    END IF;
    
  ELSIF TG_OP = 'UPDATE' THEN
    username_val := COALESCE(NEW.username, OLD.username);
    
    -- Session started (was stopped, now active)
    IF OLD.acctstoptime IS NOT NULL AND NEW.acctstoptime IS NULL THEN
      action := 'start';
      PERFORM pg_notify('session_count_change', json_build_object(
        'username', username_val,
        'action', action
      )::text);
    
    -- Session stopped (was active, now stopped)
    ELSIF OLD.acctstoptime IS NULL AND NEW.acctstoptime IS NOT NULL THEN
      action := 'stop';
      PERFORM pg_notify('session_count_change', json_build_object(
        'username', username_val,
        'action', action
      )::text);
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on INSERT (new session)
DROP TRIGGER IF EXISTS trg_notify_session_count_insert ON radacct;
CREATE TRIGGER trg_notify_session_count_insert
  AFTER INSERT ON radacct
  FOR EACH ROW
  WHEN (NEW.acctstoptime IS NULL)
  EXECUTE FUNCTION notify_session_count_change();

-- Trigger on UPDATE (session stop)
DROP TRIGGER IF EXISTS trg_notify_session_count_update ON radacct;
CREATE TRIGGER trg_notify_session_count_update
  AFTER UPDATE OF acctstoptime ON radacct
  FOR EACH ROW
  WHEN (
    (OLD.acctstoptime IS NULL AND NEW.acctstoptime IS NOT NULL)
    OR (OLD.acctstoptime IS NOT NULL AND NEW.acctstoptime IS NULL)
  )
  EXECUTE FUNCTION notify_session_count_change();

-- Add comment
COMMENT ON FUNCTION notify_session_count_change() IS 'Sends pg_notify when sessions start or stop for Redis counter updates';


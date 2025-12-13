-- Update quota trigger to handle Interim-Updates efficiently
-- This replaces the old trigger that only worked on session stop
-- Now handles both Interim-Update packets (every 5 min) and Stop packets

/* 
   OPTIMIZED ACCOUNTING TRIGGER 
   Handles Interim-Updates efficiently without application polling

   This trigger processes both:
   - Interim-Update packets (updates existing radacct row with current usage)
   - Stop packets (sets acctstoptime)
   
   For quota tracking, we sum ALL sessions for the user in the current period.
   This is idempotent and self-correcting.
*/
CREATE OR REPLACE FUNCTION update_quota_on_accounting()
RETURNS TRIGGER AS $$
DECLARE
    period_start_ts timestamp;
    period_end_ts timestamp;
BEGIN
    -- Only process if:
    -- 1. Session stopped (acctstoptime changed from NULL to a timestamp), OR
    -- 2. Usage increased (Interim-Update with more bytes)
    -- This prevents unnecessary recalculations on updates that don't change usage
    
    IF (NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL) OR
       (COALESCE(NEW.acctinputoctets, 0) > COALESCE(OLD.acctinputoctets, 0)) OR
       (COALESCE(NEW.acctoutputoctets, 0) > COALESCE(OLD.acctoutputoctets, 0)) THEN
        
        -- Only process if we have usage data
        IF COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0) > 0 THEN
            
            -- Find active quota definition
            SELECT period_start, period_end 
            INTO period_start_ts, period_end_ts
            FROM radquota 
            WHERE username = NEW.username 
            AND period_end > now() 
            AND period_start <= now()
            LIMIT 1;

            IF FOUND THEN
                -- Update the quota usage directly from the accounting session totals
                -- We use a subquery to sum ALL sessions for this user in this period
                -- This is idempotent and self-correcting
                UPDATE radquota
                SET used_octets = (
                    SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0)
                    FROM radacct
                    WHERE username = NEW.username
                    AND acctstarttime >= period_start_ts
                ),
                updated_at = now()
                WHERE username = NEW.username 
                AND period_start = period_start_ts;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on UPDATE (Interim-Update updates the existing row in radacct)
DROP TRIGGER IF EXISTS trg_update_quota ON radacct;
CREATE TRIGGER trg_update_quota
AFTER UPDATE ON radacct
FOR EACH ROW
EXECUTE FUNCTION update_quota_on_accounting();


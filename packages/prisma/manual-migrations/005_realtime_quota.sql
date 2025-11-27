-- ============================================
-- REAL-TIME QUOTA AGGREGATION
-- ============================================
-- Prevents "double dip" quota abuse across simultaneous sessions
-- Calculates total usage (historical + active) in real-time

-- ============================================
-- 1. FUNCTION: Calculate Total Usage
-- ============================================
-- Aggregates usage from both closed sessions and active sessions

CREATE OR REPLACE FUNCTION get_user_total_usage(check_username TEXT)
RETURNS BIGINT AS $$
DECLARE
    historical_usage BIGINT;
    active_usage BIGINT;
BEGIN
    -- Get usage from closed sessions (Historical)
    SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0)
    INTO historical_usage
    FROM radacct
    WHERE username = check_username
    AND acctstoptime IS NOT NULL;

    -- Get usage from CURRENT active sessions (Interim Updates)
    SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0)
    INTO active_usage
    FROM radacct
    WHERE username = check_username
    AND acctstoptime IS NULL;

    RETURN historical_usage + active_usage;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 2. DISCONNECT QUEUE TABLE
-- ============================================
-- Queue for users who exceeded quota (processed by Node.js scheduler)

CREATE TABLE IF NOT EXISTS disconnect_queue (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'QUOTA_EXCEEDED',
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMP
);

-- Create partial unique index (PostgreSQL doesn't support UNIQUE constraint with WHERE clause)
CREATE UNIQUE INDEX IF NOT EXISTS disconnect_queue_username_unique 
    ON disconnect_queue(username) 
    WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_disconnect_queue_unprocessed 
    ON disconnect_queue(username) 
    WHERE processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_disconnect_queue_created 
    ON disconnect_queue(created_at);

-- ============================================
-- 3. TRIGGER: Check Quota on Interim Updates
-- ============================================
-- Monitors radacct updates and flags users who exceed quota

CREATE OR REPLACE FUNCTION check_quota_limit_trigger()
RETURNS TRIGGER AS $$
DECLARE
    max_quota BIGINT;
    current_total BIGINT;
    plan_active BOOLEAN;
BEGIN
    -- Get the user's total allowed quota from active plan
    SELECT 
        COALESCE(up.data_quota, p.data_quota) INTO max_quota
    FROM end_users u
    JOIN user_plans up ON u.id = up.user_id
    JOIN plans p ON up.plan_id = p.id
    WHERE u.username = NEW.username 
    AND up.status = 'ACTIVE'
    AND (up.expires_at IS NULL OR up.expires_at > NOW())
    LIMIT 1;

    -- If no quota limit, exit
    IF max_quota IS NULL THEN
        RETURN NEW;
    END IF;

    -- Calculate total usage (historical + active sessions)
    current_total := get_user_total_usage(NEW.username);

    -- Check if over limit
    IF current_total >= max_quota THEN
        -- Insert into disconnect queue (ON CONFLICT prevents duplicates)
        INSERT INTO disconnect_queue (username, reason, created_at)
        VALUES (NEW.username, 'QUOTA_EXCEEDED', NOW())
        ON CONFLICT (username) WHERE processed = FALSE DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger on radacct updates (Interim-Updates from routers)
DROP TRIGGER IF EXISTS trg_check_quota ON radacct;
CREATE TRIGGER trg_check_quota
    AFTER UPDATE OF acctinputoctets, acctoutputoctets ON radacct
    FOR EACH ROW
    WHEN (
        NEW.acctstoptime IS NULL  -- Only check active sessions
        AND (OLD.acctinputoctets IS DISTINCT FROM NEW.acctinputoctets
             OR OLD.acctoutputoctets IS DISTINCT FROM NEW.acctoutputoctets)
    )
    EXECUTE FUNCTION check_quota_limit_trigger();

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ Real-Time Quota Aggregation Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE '→ Function: get_user_total_usage()';
    RAISE NOTICE '→ Table: disconnect_queue';
    RAISE NOTICE '→ Trigger: trg_check_quota';
    RAISE NOTICE '→ Architecture: Database-Native Real-Time';
    RAISE NOTICE '========================================';
END $$;


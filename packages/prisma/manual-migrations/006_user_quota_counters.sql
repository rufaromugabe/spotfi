-- ============================================
-- USER QUOTA USAGE COUNTERS
-- ============================================
-- Replaces expensive SUM() queries with incremental counter table
-- Prevents O(N) degradation as session history grows
-- Mirrors the efficient router_daily_usage pattern

-- ============================================
-- 1. USER QUOTA USAGE COUNTER TABLE
-- ============================================
-- Stores incremental usage per user per period (monthly by default)

CREATE TABLE IF NOT EXISTS user_quota_usage (
    username TEXT NOT NULL,
    period_start DATE NOT NULL,
    bytes_used BIGINT DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (username, period_start)
);

CREATE INDEX idx_user_quota_usage_username ON user_quota_usage(username, period_start DESC);
CREATE INDEX idx_user_quota_usage_period ON user_quota_usage(period_start DESC);

-- ============================================
-- 2. UPDATE get_user_total_usage() FUNCTION
-- ============================================
-- Now uses counter table instead of SUM() over all history

CREATE OR REPLACE FUNCTION get_user_total_usage(check_username TEXT)
RETURNS BIGINT AS $$
DECLARE
    counter_usage BIGINT;
    active_usage BIGINT;
    current_period DATE;
BEGIN
    -- Get current period (monthly - can be extended for daily/weekly)
    current_period := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    
    -- Get usage from counter table (fast - single row lookup)
    SELECT COALESCE(bytes_used, 0) INTO counter_usage
    FROM user_quota_usage
    WHERE username = check_username
    AND period_start = current_period;
    
    -- Get usage from CURRENT active sessions only (small set)
    SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0)
    INTO active_usage
    FROM radacct
    WHERE username = check_username
    AND acctstoptime IS NULL;
    
    RETURN COALESCE(counter_usage, 0) + COALESCE(active_usage, 0);
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 3. TRIGGER: Update Counter on Session Close
-- ============================================
-- Incrementally updates counter when session ends (not on every interim update)

CREATE OR REPLACE FUNCTION update_user_quota_counter()
RETURNS TRIGGER AS $$
DECLARE
    session_date DATE;
    session_bytes BIGINT;
BEGIN
    -- Only process when session closes (acctstoptime changes from NULL to NOT NULL)
    IF NEW.acctstoptime IS NULL OR OLD.acctstoptime IS NOT NULL THEN
        RETURN NEW;
    END IF;
    
    -- Skip if no bytes were used
    session_bytes := COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0);
    IF session_bytes = 0 THEN
        RETURN NEW;
    END IF;
    
    -- Determine period from session start date
    IF NEW.acctstarttime IS NOT NULL THEN
        session_date := DATE_TRUNC('month', NEW.acctstarttime)::DATE;
    ELSE
        session_date := DATE_TRUNC('month', CURRENT_DATE)::DATE;
    END IF;
    
    -- Update counter (incremental - O(1) operation)
    INSERT INTO user_quota_usage (username, period_start, bytes_used)
    VALUES (NEW.username, session_date, session_bytes)
    ON CONFLICT (username, period_start)
    DO UPDATE SET
        bytes_used = user_quota_usage.bytes_used + EXCLUDED.bytes_used,
        last_updated = NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger on session close
DROP TRIGGER IF EXISTS trg_update_user_quota_counter ON radacct;
CREATE TRIGGER trg_update_user_quota_counter
    AFTER UPDATE OF acctstoptime ON radacct
    FOR EACH ROW
    WHEN (OLD.acctstoptime IS NULL AND NEW.acctstoptime IS NOT NULL)
    EXECUTE FUNCTION update_user_quota_counter();

-- ============================================
-- 4. MIGRATION: Backfill Counter Table
-- ============================================
-- Initialize counter table with existing historical data
-- This is a one-time operation for existing installations

INSERT INTO user_quota_usage (username, period_start, bytes_used)
SELECT 
    username,
    DATE_TRUNC('month', acctstarttime)::DATE as period_start,
    SUM(acctinputoctets + acctoutputoctets) as bytes_used
FROM radacct
WHERE acctstoptime IS NOT NULL
  AND username IS NOT NULL
  AND acctstarttime IS NOT NULL
GROUP BY username, DATE_TRUNC('month', acctstarttime)::DATE
ON CONFLICT (username, period_start)
DO UPDATE SET
    bytes_used = EXCLUDED.bytes_used,
    last_updated = NOW();

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ User Quota Counters Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE '→ Table: user_quota_usage';
    RAISE NOTICE '→ Function: get_user_total_usage() (optimized)';
    RAISE NOTICE '→ Trigger: trg_update_user_quota_counter';
    RAISE NOTICE '→ Benefit: O(1) lookup instead of O(N) SUM';
    RAISE NOTICE '→ Architecture: Incremental Counters';
    RAISE NOTICE '========================================';
END $$;


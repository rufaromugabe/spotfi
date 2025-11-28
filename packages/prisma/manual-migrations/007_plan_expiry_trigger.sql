-- ============================================
-- PLAN EXPIRY WITH NOTIFY/LISTEN
-- ============================================
-- Event-driven plan expiry using PostgreSQL NOTIFY/LISTEN
-- Provides instant plan expiry detection (ms latency)
-- 
-- Architecture:
-- - Database triggers send NOTIFY when plans expire
-- - Application LISTENs for notifications
-- - Periodic safety check catches edge cases
--
-- Benefits:
-- - No database extension dependencies (no pg_cron needed)
-- - Instant plan expiry (ms latency vs 1 minute polling)
-- - Event-driven architecture (scalable)

-- ============================================
-- 1. Plan Expiry Function (sends NOTIFY)
-- ============================================
CREATE OR REPLACE FUNCTION batch_expire_plans()
RETURNS TABLE(
    expired_count BIGINT,
    users_affected BIGINT
) AS $$
DECLARE
    expired_plans_count BIGINT;
    unique_users_count BIGINT;
    expired_user_id TEXT;
BEGIN
    -- Mark all expired plans and get counts
    WITH expired AS (
        UPDATE user_plans
        SET status = 'EXPIRED',
            updated_at = NOW()
        WHERE status = 'ACTIVE'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING user_id, id
    )
    SELECT 
        COALESCE(COUNT(*), 0)::BIGINT,
        COALESCE(COUNT(DISTINCT user_id), 0)::BIGINT
    INTO expired_plans_count, unique_users_count
    FROM expired;
    
    -- Send NOTIFY for each expired plan (instant trigger)
    -- This allows the application to process expiry immediately
    FOR expired_user_id IN 
        SELECT DISTINCT user_id::TEXT
        FROM user_plans
        WHERE status = 'EXPIRED'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
          AND updated_at >= NOW() - INTERVAL '1 second'  -- Only newly expired
    LOOP
        PERFORM pg_notify('plan_expiry_notify', expired_user_id);
    END LOOP;

    -- Return statistics
    RETURN QUERY SELECT expired_plans_count, unique_users_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 2. Trigger for Plan Expiry on INSERT/UPDATE
-- ============================================
-- Triggers NOTIFY when a plan is created/updated with expires_at in the past
-- This enables instant expiry detection for both new and updated plans

CREATE OR REPLACE FUNCTION notify_plan_expiry_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle INSERT: Plan created with expires_at already in the past
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'ACTIVE' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW() THEN
            -- Plan created with past expiry, send NOTIFY immediately
            -- batch_expire_plans() will be called to actually expire it
            PERFORM pg_notify('plan_expiry_notify', NEW.user_id::TEXT);
        END IF;
    END IF;
    
    -- Handle UPDATE: expires_at updated to a past date while status is still ACTIVE
    IF TG_OP = 'UPDATE' THEN
        IF NEW.status = 'ACTIVE' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW() AND (OLD.expires_at IS NULL OR OLD.expires_at > NOW()) THEN
            -- Plan expired (expires_at set to past), send NOTIFY immediately
            PERFORM pg_notify('plan_expiry_notify', NEW.user_id::TEXT);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trg_notify_plan_expiry_insert ON user_plans;
DROP TRIGGER IF EXISTS trg_notify_plan_expiry_update ON user_plans;

-- Create trigger on INSERT (catches plans created with past expiry dates)
CREATE TRIGGER trg_notify_plan_expiry_insert
    AFTER INSERT ON user_plans
    FOR EACH ROW
    WHEN (NEW.status = 'ACTIVE' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW())
    EXECUTE FUNCTION notify_plan_expiry_trigger();

-- Create trigger on UPDATE (catches manual expiry updates)
CREATE TRIGGER trg_notify_plan_expiry_update
    AFTER UPDATE ON user_plans
    FOR EACH ROW
    WHEN (NEW.status = 'ACTIVE' AND NEW.expires_at IS NOT NULL AND NEW.expires_at <= NOW())
    EXECUTE FUNCTION notify_plan_expiry_trigger();

-- ============================================
-- 3. Periodic Check Function (safety net)
-- ============================================
-- Called periodically (every minute) by the application scheduler
-- to catch any plans that might have expired between NOTIFY events
-- It's a safety net for edge cases

CREATE OR REPLACE FUNCTION check_and_expire_plans()
RETURNS TABLE(
    expired_count BIGINT,
    users_affected BIGINT
) AS $$
DECLARE
    expired_plans_count BIGINT;
    unique_users_count BIGINT;
    result_record RECORD;
BEGIN
    -- Call batch_expire_plans which handles NOTIFY internally
    -- Use explicit column names to avoid ambiguity
    SELECT result.expired_count, result.users_affected
    INTO expired_plans_count, unique_users_count
    FROM batch_expire_plans() AS result;
    
    RETURN QUERY SELECT expired_plans_count, unique_users_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ Plan Expiry with NOTIFY/LISTEN Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE '→ Function: batch_expire_plans() (sends NOTIFY)';
    RAISE NOTICE '→ Function: check_and_expire_plans() (safety net, runs every 30s)';
    RAISE NOTICE '→ Trigger: trg_notify_plan_expiry_insert (on INSERT, catches past expiry)';
    RAISE NOTICE '→ Trigger: trg_notify_plan_expiry_update (on UPDATE, catches manual expiry)';
    RAISE NOTICE '→ Channel: plan_expiry_notify';
    RAISE NOTICE '→ Architecture: Event-driven (NOTIFY/LISTEN + Redis)';
    RAISE NOTICE '→ Benefit: Instant plan expiry (ms latency), max 29s delay for time-based expiry';
    RAISE NOTICE '========================================';
END $$;


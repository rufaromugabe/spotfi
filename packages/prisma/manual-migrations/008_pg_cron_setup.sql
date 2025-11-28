-- ============================================
-- pg_cron Extension Setup (PRIMARY METHOD)
-- ============================================
-- This provides database-native scheduled jobs for plan expiry
-- Plan expiry is handled entirely by pg_cron (no application cron needed)
-- 
-- To check if available: SELECT * FROM pg_available_extensions WHERE name = 'pg_cron';
-- To install: CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ============================================
-- 1. Check if pg_cron is available
-- ============================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron'
    ) THEN
        -- Enable pg_cron extension
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        
        RAISE NOTICE '✅ pg_cron extension enabled';
    ELSE
        RAISE NOTICE '⚠️  pg_cron extension not available - skipping';
        RAISE NOTICE '   To enable: Install pg_cron extension in PostgreSQL';
        RAISE NOTICE '   Or use application-level cron (already configured)';
    END IF;
END $$;

-- ============================================
-- 2. Schedule Plan Expiry Job (PRIMARY METHOD)
-- ============================================
-- Runs every minute to proactively expire plans
-- This is the PRIMARY method - no application cron needed

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) THEN
        -- Unschedule any existing job
        PERFORM cron.unschedule('plan-expiry-check');
        
        -- Schedule new job: Run every minute
        PERFORM cron.schedule(
            'plan-expiry-check',
            '* * * * *',  -- Every minute
            $$SELECT batch_expire_plans()$$
        );
        
        RAISE NOTICE '✅ Scheduled pg_cron job: plan-expiry-check (every minute)';
        RAISE NOTICE '   → This is the PRIMARY method for plan expiry';
        RAISE NOTICE '   → Application cron can be removed/disabled';
    ELSE
        RAISE NOTICE '❌ pg_cron not enabled - plan expiry will not work!';
        RAISE NOTICE '   → Install pg_cron extension: CREATE EXTENSION IF NOT EXISTS pg_cron;';
        RAISE NOTICE '   → Or use application cron as fallback (see scheduler.ts)';
    END IF;
END $$;

-- ============================================
-- 3. Function to Disable Users with No Active Plans
-- ============================================
-- Called after batch_expire_plans() to disable users
-- This ensures users without active plans are immediately rejected

CREATE OR REPLACE FUNCTION disable_users_without_plans()
RETURNS TABLE(
    disabled_count BIGINT
) AS $$
DECLARE
    disabled_users_count BIGINT;
BEGIN
    -- Disable users with no active plans
    -- Also add to disconnect_queue for BullMQ processing (disconnect active sessions)
    WITH users_to_disable AS (
        SELECT DISTINCT u.username
        FROM end_users u
        WHERE NOT EXISTS (
            SELECT 1
            FROM user_plans up
            WHERE up.user_id = u.id
              AND up.status = 'ACTIVE'
              AND (up.expires_at IS NULL OR up.expires_at > NOW())
        )
        AND EXISTS (
            SELECT 1
            FROM user_plans up2
            WHERE up2.user_id = u.id
              AND up2.status = 'EXPIRED'
        )
    ),
    -- Add to disconnect_queue (for BullMQ to process)
    -- Only queue users with active sessions (prevents duplicates via manual check)
    queued AS (
        INSERT INTO disconnect_queue (username, reason, processed)
        SELECT DISTINCT u.username, 'PLAN_EXPIRED', FALSE
        FROM users_to_disable u
        WHERE EXISTS (
            SELECT 1
            FROM radacct
            WHERE radacct.username = u.username
              AND radacct.acctstoptime IS NULL
        )
        AND NOT EXISTS (
            SELECT 1
            FROM disconnect_queue dq
            WHERE dq.username = u.username
              AND dq.processed = FALSE
        )
    ),
    -- Disable in RADIUS (prevent re-authentication)
    disabled AS (
        INSERT INTO radcheck (username, attribute, op, value)
        SELECT username, 'Auth-Type', ':=', 'Reject'
        FROM users_to_disable
        ON CONFLICT (username, attribute) 
        DO UPDATE SET value = 'Reject', op = ':='
        RETURNING username
    )
    SELECT COUNT(*)::BIGINT INTO disabled_users_count
    FROM disabled;

    RETURN QUERY SELECT COALESCE(disabled_users_count, 0)::BIGINT;
END;
$$ LANGUAGE plpgsql;

-- Schedule job to disable users after expiry check
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) THEN
        -- Unschedule any existing job
        PERFORM cron.unschedule('disable-users-no-plans');
        
        -- Schedule new job: Run every minute (right after expiry check)
        PERFORM cron.schedule(
            'disable-users-no-plans',
            '* * * * *',  -- Every minute
            $$SELECT disable_users_without_plans()$$
        );
        
        RAISE NOTICE '✅ Scheduled pg_cron job: disable-users-no-plans (every minute)';
    END IF;
END $$;

-- ============================================
-- NOTES
-- ============================================
-- pg_cron provides database-native scheduling
-- Benefits:
--   • Survives application restarts
--   • Runs inside database (no network overhead)
--   • Atomic operations
--
-- If pg_cron is not available, the application-level
-- cron job in scheduler.ts will handle plan expiry
-- (runs hourly as backup to event-based triggers)


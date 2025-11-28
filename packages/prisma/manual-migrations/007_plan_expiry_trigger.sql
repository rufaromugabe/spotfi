-- ============================================
-- PLAN EXPIRY FUNCTION (for pg_cron)
-- ============================================
-- Batch function to expire plans - called by pg_cron
-- This is the primary method for plan expiry

CREATE OR REPLACE FUNCTION batch_expire_plans()
RETURNS TABLE(
    expired_count BIGINT,
    users_affected BIGINT
) AS $$
DECLARE
    expired_plans_count BIGINT;
    unique_users_count BIGINT;
BEGIN
    -- Mark all expired plans and get counts
    WITH expired AS (
        UPDATE user_plans
        SET status = 'EXPIRED',
            updated_at = NOW()
        WHERE status = 'ACTIVE'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
        RETURNING user_id
    )
    SELECT 
        COALESCE(COUNT(*), 0)::BIGINT,
        COALESCE(COUNT(DISTINCT user_id), 0)::BIGINT
    INTO expired_plans_count, unique_users_count
    FROM expired;

    -- Return statistics
    RETURN QUERY SELECT expired_plans_count, unique_users_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ Plan Expiry Function Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE '→ Function: batch_expire_plans()';
    RAISE NOTICE '→ Usage: Called by pg_cron (see 008_pg_cron_setup.sql)';
    RAISE NOTICE '→ Architecture: Database-Native Scheduling (pg_cron)';
    RAISE NOTICE '========================================';
END $$;


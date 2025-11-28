-- ============================================
-- PG_NOTIFY for Disconnect Queue
-- ============================================
-- Adds NOTIFY to disconnect_queue trigger for real-time processing
-- Replaces polling mechanism with event-driven architecture
-- 
-- Benefits:
-- - ms-latency processing instead of 10s polling delay
-- - Eliminates database read overhead from polling
-- - Near real-time quota enforcement

-- ============================================
-- 1. UPDATE check_quota_limit_trigger() FUNCTION
-- ============================================
-- Add NOTIFY when inserting into disconnect_queue

CREATE OR REPLACE FUNCTION check_quota_limit_trigger()
RETURNS TRIGGER AS $$
DECLARE
    max_quota BIGINT;
    current_total BIGINT;
    plan_active BOOLEAN;
    notify_payload TEXT;
BEGIN
    -- Get the user's total allowed quota by SUMMING all active plans (multi-plan pooling)
    -- If any plan has unlimited quota (NULL), return NULL to allow unlimited access
    SELECT 
        CASE 
            WHEN COUNT(*) FILTER (WHERE COALESCE(up.data_quota, p.data_quota) IS NULL) > 0 
            THEN NULL
            ELSE SUM(COALESCE(up.data_quota, p.data_quota))
        END INTO max_quota
    FROM end_users u
    JOIN user_plans up ON u.id = up.user_id
    JOIN plans p ON up.plan_id = p.id
    WHERE u.username = NEW.username 
    AND up.status = 'ACTIVE'
    AND (up.expires_at IS NULL OR up.expires_at > NOW())
    HAVING COUNT(*) > 0;

    -- If no quota limit (unlimited or no active plans), exit
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
        ON CONFLICT (username) WHERE processed = FALSE DO NOTHING
        RETURNING id INTO notify_payload;
        
        -- Send NOTIFY if row was actually inserted (not a duplicate)
        IF notify_payload IS NOT NULL THEN
            PERFORM pg_notify('disconnect_queue_notify', NEW.username);
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 2. UPDATE disable_users_without_plans() FUNCTION
-- ============================================
-- Add NOTIFY when queueing plan expiry disconnects

CREATE OR REPLACE FUNCTION disable_users_without_plans()
RETURNS TABLE(
    disabled_count BIGINT
) AS $$
DECLARE
    disabled_users_count BIGINT;
    queued_username TEXT;
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
        RETURNING username
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
    
    -- Send NOTIFY for each queued user
    FOR queued_username IN SELECT username FROM queued
    LOOP
        PERFORM pg_notify('disconnect_queue_notify', queued_username);
    END LOOP;

    RETURN QUERY SELECT COALESCE(disabled_users_count, 0)::BIGINT;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ PG_NOTIFY for Disconnect Queue Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE '→ Channel: disconnect_queue_notify';
    RAISE NOTICE '→ Trigger: check_quota_limit_trigger() (updated)';
    RAISE NOTICE '→ Function: disable_users_without_plans() (updated)';
    RAISE NOTICE '→ Benefit: ms-latency processing (replaces 10s polling)';
    RAISE NOTICE '→ Architecture: Event-driven (PG_NOTIFY)';
    RAISE NOTICE '========================================';
END $$;


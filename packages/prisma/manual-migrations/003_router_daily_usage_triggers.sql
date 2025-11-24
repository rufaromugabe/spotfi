-- ============================================
-- MATERIALIZED COUNTERS: router_daily_usage
-- ============================================
-- Real-time aggregation table updated via triggers
-- Replaces expensive SUM() queries on radacct (millions of rows)
-- Query router_daily_usage (hundreds of rows) instead

-- Drop existing table if exists
DROP TABLE IF EXISTS router_daily_usage CASCADE;

-- Create summary table
CREATE TABLE router_daily_usage (
    router_id TEXT NOT NULL,
    usage_date DATE NOT NULL,
    bytes_in BIGINT DEFAULT 0,
    bytes_out BIGINT DEFAULT 0,
    PRIMARY KEY (router_id, usage_date)
);

-- Create indexes for fast queries
CREATE INDEX idx_router_daily_usage_router ON router_daily_usage(router_id);
CREATE INDEX idx_router_daily_usage_date ON router_daily_usage(usage_date DESC);
CREATE INDEX idx_router_daily_usage_router_date ON router_daily_usage(router_id, usage_date DESC);

-- ============================================
-- TRIGGER FUNCTION: Update router_daily_usage
-- ============================================
-- Updates summary table on every radacct UPDATE (Accounting Stop or Interim-Update)
-- Uses delta calculation for efficiency

CREATE OR REPLACE FUNCTION update_router_daily_usage()
RETURNS TRIGGER AS $$
DECLARE
    delta_in BIGINT := 0;
    delta_out BIGINT := 0;
    session_date DATE;
BEGIN
    -- Only process if routerId is set
    IF NEW."routerId" IS NULL THEN
        RETURN NEW;
    END IF;

    -- Determine date from acctStartTime or acctUpdateTime
    IF NEW.acctstarttime IS NOT NULL THEN
        session_date := DATE(NEW.acctstarttime);
    ELSIF NEW.acctupdatetime IS NOT NULL THEN
        session_date := DATE(NEW.acctupdatetime);
    ELSE
        -- Fallback to current date
        session_date := CURRENT_DATE;
    END IF;

    -- Calculate delta (change in bytes)
    IF TG_OP = 'UPDATE' THEN
        -- Calculate difference between old and new values
        delta_in := COALESCE(NEW.acctinputoctets, 0) - COALESCE(OLD.acctinputoctets, 0);
        delta_out := COALESCE(NEW.acctoutputoctets, 0) - COALESCE(OLD.acctoutputoctets, 0);
        
        -- Skip if no change
        IF delta_in = 0 AND delta_out = 0 THEN
            RETURN NEW;
        END IF;
    ELSIF TG_OP = 'INSERT' THEN
        -- New session: add initial bytes
        delta_in := COALESCE(NEW.acctinputoctets, 0);
        delta_out := COALESCE(NEW.acctoutputoctets, 0);
    ELSE
        RETURN NEW;
    END IF;

    -- Upsert into summary table (atomic)
    INSERT INTO router_daily_usage (router_id, usage_date, bytes_in, bytes_out)
    VALUES (NEW."routerId", session_date, delta_in, delta_out)
    ON CONFLICT (router_id, usage_date) 
    DO UPDATE SET
        bytes_in = router_daily_usage.bytes_in + EXCLUDED.bytes_in,
        bytes_out = router_daily_usage.bytes_out + EXCLUDED.bytes_out;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- TRIGGERS
-- ============================================

-- Trigger on UPDATE (Accounting Stop or Interim-Update)
-- This is the main trigger that fires when sessions end or update
DROP TRIGGER IF EXISTS trg_update_router_daily_usage ON radacct;
CREATE TRIGGER trg_update_router_daily_usage
    AFTER UPDATE OF acctinputoctets, acctoutputoctets, acctstoptime ON radacct
    FOR EACH ROW
    WHEN (
        NEW."routerId" IS NOT NULL
        AND (
            OLD.acctinputoctets IS DISTINCT FROM NEW.acctinputoctets
            OR OLD.acctoutputoctets IS DISTINCT FROM NEW.acctoutputoctets
            OR (OLD.acctstoptime IS NULL AND NEW.acctstoptime IS NOT NULL)
        )
    )
    EXECUTE FUNCTION update_router_daily_usage();

-- Trigger on INSERT (for sessions that start with bytes already set)
DROP TRIGGER IF EXISTS trg_insert_router_daily_usage ON radacct;
CREATE TRIGGER trg_insert_router_daily_usage
    AFTER INSERT ON radacct
    FOR EACH ROW
    WHEN (NEW."routerId" IS NOT NULL AND (NEW.acctinputoctets > 0 OR NEW.acctoutputoctets > 0))
    EXECUTE FUNCTION update_router_daily_usage();

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE '✅ Router Daily Usage Triggers Installed';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Table: router_daily_usage';
    RAISE NOTICE 'Benefit: Query hundreds of rows instead of millions';
    RAISE NOTICE '→ Real-time updates via triggers';
    RAISE NOTICE '→ Use for billing and analytics';
    RAISE NOTICE '========================================';
END $$;


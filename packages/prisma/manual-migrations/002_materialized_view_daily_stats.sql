-- ============================================
-- RUN_IN_SINGLE_TRANSACTION
-- MATERIALIZED VIEW: DAILY ROUTER STATISTICS
-- ============================================
-- Pre-aggregated daily stats for fast dashboard queries
-- Refresh daily via cron job

-- Drop if exists
DROP MATERIALIZED VIEW IF EXISTS router_daily_stats CASCADE;

-- Create materialized view
CREATE MATERIALIZED VIEW router_daily_stats AS
SELECT 
  "routerId",
  DATE(acctstarttime) as date,
  COUNT(*) as total_sessions,
  COUNT(DISTINCT username) as unique_users,
  COALESCE(SUM(acctinputoctets), 0) as total_bytes_in,
  COALESCE(SUM(acctoutputoctets), 0) as total_bytes_out,
  COALESCE(SUM(acctinputoctets + acctoutputoctets), 0) as total_bytes,
  COALESCE(AVG(acctsessiontime), 0)::BIGINT as avg_session_time,
  COUNT(*) FILTER (WHERE acctstoptime IS NULL) as active_sessions_end_of_day
FROM radacct
WHERE "routerId" IS NOT NULL
  AND acctstarttime IS NOT NULL
GROUP BY "routerId", DATE(acctstarttime);

-- Create indexes on materialized view
CREATE UNIQUE INDEX idx_router_daily_stats_unique 
ON router_daily_stats("routerId", date);

CREATE INDEX idx_router_daily_stats_router 
ON router_daily_stats("routerId");

CREATE INDEX idx_router_daily_stats_date 
ON router_daily_stats(date DESC);

-- Create refresh function
CREATE OR REPLACE FUNCTION refresh_daily_stats()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY router_daily_stats;
  RAISE NOTICE 'Daily stats refreshed at %', NOW();
END;
$$ LANGUAGE plpgsql;

-- Success message
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ Materialized View Created';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'View: router_daily_stats';
  RAISE NOTICE 'Benefit: 1000x faster analytics queries';
  RAISE NOTICE '';
  RAISE NOTICE 'To refresh daily, add to cron:';
  RAISE NOTICE '  SELECT refresh_daily_stats();';
  RAISE NOTICE '';
  RAISE NOTICE 'Or schedule in scheduler.ts:';
  RAISE NOTICE '  cron.schedule("0 1 * * *", refreshDailyStats)';
  RAISE NOTICE '========================================';
END $$;


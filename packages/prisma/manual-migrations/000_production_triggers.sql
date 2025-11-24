-- ============================================
-- PRODUCTION RADIUS ACCOUNTING TRIGGERS
-- ============================================
-- Real-time, zero-sync architecture for ISP accounting
-- Handles: router linking, usage tracking, billing data

-- ============================================
-- 1. AUTO-LINK ROUTER TO SESSIONS
-- ============================================
-- Links routerId instantly when RADIUS creates accounting records
-- Priority: NAS-Identifier > Class > IP > MAC

CREATE OR REPLACE FUNCTION link_router_to_session()
RETURNS TRIGGER AS $$
DECLARE
  router_match TEXT;
BEGIN
  -- Skip if already linked
  IF NEW."routerId" IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Method 1: Router sends ID in NAS-Identifier (preferred)
  IF NEW.nasidentifier IS NOT NULL THEN
    SELECT id INTO router_match
    FROM routers
    WHERE id = NEW.nasidentifier
       OR id = SUBSTRING(NEW.nasidentifier FROM 5)  -- Handle 'rtr-' prefix
    LIMIT 1;
    
    IF router_match IS NOT NULL THEN
      NEW."routerId" := router_match;
      RETURN NEW;
    END IF;
  END IF;

  -- Method 2: FreeRADIUS sets router ID in Class attribute
  IF NEW.class IS NOT NULL THEN
    SELECT id INTO router_match
    FROM routers
    WHERE id = NEW.class
    LIMIT 1;
    
    IF router_match IS NOT NULL THEN
      NEW."routerId" := router_match;
      RETURN NEW;
    END IF;
  END IF;

  -- Method 3: Match by IP address (fast)
  IF NEW.nasipaddress IS NOT NULL THEN
    SELECT id INTO router_match
    FROM routers
    WHERE nasipaddress = NEW.nasipaddress
    LIMIT 1;
    
    IF router_match IS NOT NULL THEN
      NEW."routerId" := router_match;
      RETURN NEW;
    END IF;
  END IF;

  -- Method 4: Match by MAC address in nasidentifier (reliable)
  IF NEW.nasidentifier IS NOT NULL THEN
    SELECT id INTO router_match
    FROM routers
    WHERE "macAddress" IS NOT NULL
      AND (
        NEW.nasidentifier ILIKE '%' || "macAddress" || '%'
        OR NEW.nasidentifier ILIKE '%' || REPLACE(REPLACE("macAddress", ':', ''), '-', '') || '%'
      )
    LIMIT 1;
    
    IF router_match IS NOT NULL THEN
      NEW."routerId" := router_match;
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger on INSERT
DROP TRIGGER IF EXISTS trg_link_router_insert ON radacct;
CREATE TRIGGER trg_link_router_insert
  BEFORE INSERT ON radacct
  FOR EACH ROW
  EXECUTE FUNCTION link_router_to_session();

-- Apply trigger on UPDATE (for late-arriving nasipaddress)
DROP TRIGGER IF EXISTS trg_link_router_update ON radacct;
CREATE TRIGGER trg_link_router_update
  BEFORE UPDATE ON radacct
  FOR EACH ROW
  WHEN (OLD."routerId" IS NULL AND NEW.nasipaddress IS NOT NULL)
  EXECUTE FUNCTION link_router_to_session();

-- ============================================
-- 2. REAL-TIME USAGE TRACKING (DELTA-BASED)
-- ============================================
-- Updates router.totalUsage using delta calculation (100x faster than full SUM)
-- Only calculates the CHANGE in bytes, not re-summing all sessions

CREATE OR REPLACE FUNCTION update_router_usage()
RETURNS TRIGGER AS $$
DECLARE
  delta_bytes BIGINT := 0;
  delta_mb NUMERIC;
BEGIN
  IF NEW."routerId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Calculate only the CHANGE (delta), not full sum
  IF TG_OP = 'INSERT' THEN
    -- New session: add its bytes
    delta_bytes := COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0);
    
  ELSIF TG_OP = 'UPDATE' THEN
    -- Session updated: add the difference
    delta_bytes := (COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0))
                 - (COALESCE(OLD.acctinputoctets, 0) + COALESCE(OLD.acctoutputoctets, 0));
    
    -- Skip if no change in bytes
    IF delta_bytes = 0 THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Convert to MB
  delta_mb := delta_bytes / 1024.0 / 1024.0;

  -- Only update if delta is significant (> 0.1 MB = 100KB)
  IF ABS(delta_bytes) > 100000 THEN
    UPDATE routers
    SET "totalUsage" = COALESCE("totalUsage", 0) + delta_mb,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = NEW."routerId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on session end (most important)
DROP TRIGGER IF EXISTS trg_usage_on_stop ON radacct;
CREATE TRIGGER trg_usage_on_stop
  AFTER UPDATE OF acctstoptime ON radacct
  FOR EACH ROW
  WHEN (NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL AND NEW."routerId" IS NOT NULL)
  EXECUTE FUNCTION update_router_usage();

-- Trigger on interim updates (keeps usage current during long sessions)
DROP TRIGGER IF EXISTS trg_usage_on_update ON radacct;
CREATE TRIGGER trg_usage_on_update
  AFTER UPDATE OF acctinputoctets, acctoutputoctets ON radacct
  FOR EACH ROW
  WHEN (
    NEW."routerId" IS NOT NULL
    AND (OLD.acctinputoctets IS DISTINCT FROM NEW.acctinputoctets
         OR OLD.acctoutputoctets IS DISTINCT FROM NEW.acctoutputoctets)
  )
  EXECUTE FUNCTION update_router_usage();

-- Trigger on new session insert (if routerId set immediately)
DROP TRIGGER IF EXISTS trg_usage_on_insert ON radacct;
CREATE TRIGGER trg_usage_on_insert
  AFTER INSERT ON radacct
  FOR EACH ROW
  WHEN (NEW."routerId" IS NOT NULL)
  EXECUTE FUNCTION update_router_usage();

-- Trigger on late routerId linking
DROP TRIGGER IF EXISTS trg_usage_on_link ON radacct;
CREATE TRIGGER trg_usage_on_link
  AFTER UPDATE OF "routerId" ON radacct
  FOR EACH ROW
  WHEN (OLD."routerId" IS NULL AND NEW."routerId" IS NOT NULL)
  EXECUTE FUNCTION update_router_usage();

-- ============================================
-- 3. PERFORMANCE INDEXES
-- ============================================

CREATE INDEX IF NOT EXISTS idx_radacct_router_lookup 
  ON radacct("routerId", acctinputoctets, acctoutputoctets)
  WHERE "routerId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_radacct_nasip 
  ON radacct(nasipaddress) 
  WHERE "routerId" IS NULL;

CREATE INDEX IF NOT EXISTS idx_routers_nasip 
  ON routers(nasipaddress) 
  WHERE nasipaddress IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_routers_mac 
  ON routers("macAddress") 
  WHERE "macAddress" IS NOT NULL;

-- ============================================
-- INITIALIZATION COMPLETE
-- ============================================
DO $$
BEGIN
  RAISE NOTICE '========================================';
  RAISE NOTICE '✅ Production Triggers Installed';
  RAISE NOTICE '========================================';
  RAISE NOTICE '→ Router linking: INSTANT';
  RAISE NOTICE '→ Usage tracking: REAL-TIME';
  RAISE NOTICE '→ Architecture: ZERO-SYNC';
  RAISE NOTICE '========================================';
END $$;

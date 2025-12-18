-- ============================================
-- CTO ARCHITECTURAL FIXES MIGRATION
-- ============================================

-- 1. FIX ROUTER SECRETS
-- Backfill radius_secret column if it was renamed to uam_secret
DO $$ 
BEGIN 
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='routers' AND column_name='radius_secret') THEN
        ALTER TABLE "routers" ADD COLUMN "radius_secret" TEXT;
        -- Move existing data if radius_secret was renamed to uam_secret
        UPDATE "routers" SET "radius_secret" = "uam_secret" WHERE "radius_secret" IS NULL;
    END IF;
END $$;

-- 2. OPTIMIZE QUOTA ENFORCEMENT (Incremental Updates)
-- Replaces expensive SUM() with O(1) incremental calculation
CREATE OR REPLACE FUNCTION update_quota_on_accounting()
RETURNS TRIGGER AS $$
DECLARE
    usage_delta BIGINT;
BEGIN
    -- Only process if:
    -- 1. Session stopped, OR
    -- 2. Usage increased
    
    IF (NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL) OR
       (COALESCE(NEW.acctinputoctets, 0) > COALESCE(OLD.acctinputoctets, 0)) OR
       (COALESCE(NEW.acctoutputoctets, 0) > COALESCE(OLD.acctoutputoctets, 0)) THEN
        
        -- Calculate usage delta (NEW - OLD)
        usage_delta := (COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0)) - 
                      (COALESCE(OLD.acctinputoctets, 0) + COALESCE(OLD.acctoutputoctets, 0));

        IF usage_delta > 0 THEN
            -- Find the active quota for this user and increment used_octets
            UPDATE radquota
            SET used_octets = used_octets + usage_delta,
                updated_at = now()
            WHERE username = NEW.username 
            AND period_end > now() 
            AND period_start <= now();
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. ENSURE NAS IDENTIFICATION (Standard Secret Management)
-- Ensure NAS entries use the router ID and radius_secret
-- Update existing NAS entries to use radius_secret from router table
UPDATE nas n
SET secret = r.radius_secret
FROM routers r
WHERE n.nasname = r.id;

DO $$
BEGIN
    RAISE NOTICE '✅ CTO Architectural Fixes Applied';
    RAISE NOTICE '→ router.radius_secret restored';
    RAISE NOTICE '→ Incremental quota tracking enabled (O(1))';
    RAISE NOTICE '→ NAS secrets synced';
END $$;

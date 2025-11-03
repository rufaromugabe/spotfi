-- Migration: Ensure router MAC address is always available in RADIUS accounting records
-- This creates a trigger that auto-populates router MAC based on IP lookup

-- Add nasmacaddress column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'nasmacaddress'
  ) THEN
    ALTER TABLE radacct ADD COLUMN nasmacaddress VARCHAR(17);
    CREATE INDEX IF NOT EXISTS idx_radacct_nasmacaddress ON radacct(nasmacaddress);
  END IF;
END $$;

-- Function to update router MAC in accounting records based on IP lookup
CREATE OR REPLACE FUNCTION update_accounting_router_mac()
RETURNS TRIGGER AS $$
BEGIN
  -- Look up router MAC address by IP address
  -- This ensures router MAC is always available even if router doesn't send it
  IF NEW.nasmacaddress IS NULL OR NEW.nasmacaddress = '' THEN
    SELECT "macAddress" INTO NEW.nasmacaddress
    FROM routers
    WHERE "nasipaddress" = NEW.nasipaddress
      AND "macAddress" IS NOT NULL
    LIMIT 1;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-populate router MAC when accounting records are inserted/updated
DROP TRIGGER IF EXISTS trigger_update_accounting_router_mac ON radacct;

CREATE TRIGGER trigger_update_accounting_router_mac
  BEFORE INSERT OR UPDATE ON radacct
  FOR EACH ROW
  EXECUTE FUNCTION update_accounting_router_mac();

-- Backfill existing records with router MAC addresses
UPDATE radacct 
SET nasmacaddress = (
  SELECT "macAddress" 
  FROM routers 
  WHERE routers."nasipaddress" = radacct.nasipaddress 
    AND routers."macAddress" IS NOT NULL
  LIMIT 1
)
WHERE nasmacaddress IS NULL 
  AND EXISTS (
    SELECT 1 FROM routers 
    WHERE routers."nasipaddress" = radacct.nasipaddress 
      AND routers."macAddress" IS NOT NULL
  );


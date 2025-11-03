-- Migration to enhance radacct table with missing FreeRADIUS columns
-- This matches the standard FreeRADIUS PostgreSQL schema

-- Add missing columns to radacct if they don't exist
DO $$
BEGIN
  -- Add realm column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'realm'
  ) THEN
    ALTER TABLE radacct ADD COLUMN realm text;
  END IF;

  -- Add NASPortId column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'nasportid'
  ) THEN
    ALTER TABLE radacct ADD COLUMN nasportid text;
  END IF;

  -- Add NASPortType column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'nasporttype'
  ) THEN
    ALTER TABLE radacct ADD COLUMN nasporttype text;
  END IF;

  -- Add AcctUpdateTime column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'acctupdatetime'
  ) THEN
    ALTER TABLE radacct ADD COLUMN acctupdatetime timestamp with time zone;
  END IF;

  -- Add AcctInterval column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'acctinterval'
  ) THEN
    ALTER TABLE radacct ADD COLUMN acctinterval bigint;
  END IF;

  -- Add AcctAuthentic column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'acctauthentic'
  ) THEN
    ALTER TABLE radacct ADD COLUMN acctauthentic text;
  END IF;

  -- Add ConnectInfo_start column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'connectinfo_start'
  ) THEN
    ALTER TABLE radacct ADD COLUMN connectinfo_start text;
  END IF;

  -- Add ConnectInfo_stop column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'connectinfo_stop'
  ) THEN
    ALTER TABLE radacct ADD COLUMN connectinfo_stop text;
  END IF;

  -- Add CalledStationId column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'calledstationid'
  ) THEN
    ALTER TABLE radacct ADD COLUMN calledstationid text;
  END IF;

  -- Add CallingStationId column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'callingstationid'
  ) THEN
    ALTER TABLE radacct ADD COLUMN callingstationid text;
  END IF;

  -- Add AcctTerminateCause column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'acctterminatecause'
  ) THEN
    ALTER TABLE radacct ADD COLUMN acctterminatecause text;
  END IF;

  -- Add ServiceType column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'servicetype'
  ) THEN
    ALTER TABLE radacct ADD COLUMN servicetype text;
  END IF;

  -- Add FramedProtocol column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'framedprotocol'
  ) THEN
    ALTER TABLE radacct ADD COLUMN framedprotocol text;
  END IF;

  -- Add FramedIPv6Address column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'framedipv6address'
  ) THEN
    ALTER TABLE radacct ADD COLUMN framedipv6address inet;
  END IF;

  -- Add FramedIPv6Prefix column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'framedipv6prefix'
  ) THEN
    ALTER TABLE radacct ADD COLUMN framedipv6prefix inet;
  END IF;

  -- Add FramedInterfaceId column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'framedinterfaceid'
  ) THEN
    ALTER TABLE radacct ADD COLUMN framedinterfaceid text;
  END IF;

  -- Add DelegatedIPv6Prefix column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'delegatedipv6prefix'
  ) THEN
    ALTER TABLE radacct ADD COLUMN delegatedipv6prefix inet;
  END IF;

  -- Add Class column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'radacct' AND column_name = 'class'
  ) THEN
    ALTER TABLE radacct ADD COLUMN Class text;
  END IF;
END $$;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_radacct_realm ON radacct(realm);
CREATE INDEX IF NOT EXISTS idx_radacct_nasportid ON radacct(nasportid);
CREATE INDEX IF NOT EXISTS idx_radacct_calledstationid ON radacct(calledstationid);
CREATE INDEX IF NOT EXISTS idx_radacct_callingstationid ON radacct(callingstationid);
CREATE INDEX IF NOT EXISTS idx_radacct_acctinterval ON radacct(acctinterval);
CREATE INDEX IF NOT EXISTS idx_radacct_acctstoptime ON radacct(acctstoptime);
CREATE INDEX IF NOT EXISTS idx_radacct_class ON radacct(Class);
CREATE INDEX IF NOT EXISTS idx_radacct_framedipv6address ON radacct(framedipv6address);
CREATE INDEX IF NOT EXISTS idx_radacct_framedipv6prefix ON radacct(framedipv6prefix);
CREATE INDEX IF NOT EXISTS idx_radacct_framedinterfaceid ON radacct(framedinterfaceid);
CREATE INDEX IF NOT EXISTS idx_radacct_delegatedipv6prefix ON radacct(delegatedipv6prefix);


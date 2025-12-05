-- Index for callingStationId (MAC address) on active sessions
-- Used for efficient lookups when kicking clients by MAC address
-- Partial index: only indexes active sessions (WHERE acctstoptime IS NULL)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_radacct_mac 
ON radacct(callingstationid) 
WHERE acctstoptime IS NULL;

-- Add comment
COMMENT ON INDEX idx_radacct_mac IS 'Partial index on MAC address for active sessions only - used for efficient client kick operations';


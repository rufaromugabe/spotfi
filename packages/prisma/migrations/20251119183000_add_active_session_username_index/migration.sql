-- Migration: Add index for active session checks by username
-- This optimizes portal login queries that check for existing active sessions
-- Created: 2025-11-19
--
-- This is a partial index that only includes rows where acctstoptime IS NULL (active sessions)
-- This significantly speeds up queries like: 
--   SELECT * FROM radacct WHERE username = ? AND acctstoptime IS NULL

-- CreateIndex
CREATE INDEX IF NOT EXISTS "radacct_active_session_username_idx" 
ON "radacct"("username", "acctstoptime") 
WHERE "acctstoptime" IS NULL;


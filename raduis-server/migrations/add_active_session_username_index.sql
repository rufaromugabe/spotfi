-- Migration: Add index for active session checks by username
-- This optimizes portal login queries that check for existing active sessions
-- Created: 2024

-- Add index for active session checks by username
-- This is a partial index that only includes rows where AcctStopTime IS NULL (active sessions)
-- This significantly speeds up queries like: SELECT * FROM radacct WHERE username = ? AND acctstoptime IS NULL
CREATE INDEX IF NOT EXISTS radacct_active_session_username_idx 
ON radacct (UserName, AcctStopTime) 
WHERE AcctStopTime IS NULL;

-- Note: This index uses mixed case (UserName, AcctStopTime) to match the schema
-- PostgreSQL will automatically match to lowercase column names in queries


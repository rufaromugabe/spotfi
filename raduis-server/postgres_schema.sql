/*
 * $Id: 518bc5d2ecf22b546b2cdd4845eee542fc916b25 $
 *
 * PostgreSQL schema for FreeRADIUS
 *
 */

/*
 * Table structure for table 'radacct'
 *
 */
CREATE TABLE IF NOT EXISTS radacct (
	RadAcctId		bigserial PRIMARY KEY,
	AcctSessionId		text NOT NULL,
	AcctUniqueId		text NOT NULL UNIQUE,
	UserName		text,
	Realm			text,
	NASIPAddress		inet NOT NULL,
	NASPortId		text,
	NASPortType		text,
	AcctStartTime		timestamp with time zone,
	AcctUpdateTime		timestamp with time zone,
	AcctStopTime		timestamp with time zone,
	AcctInterval		bigint,
	AcctSessionTime		bigint,
	AcctAuthentic		text,
	ConnectInfo_start	text,
	ConnectInfo_stop	text,
	AcctInputOctets		bigint,
	AcctOutputOctets	bigint,
	CalledStationId		text,
	CallingStationId	text,
	AcctTerminateCause	text,
	ServiceType		text,
	FramedProtocol		text,
	FramedIPAddress		inet,
	FramedIPv6Address	inet,
	FramedIPv6Prefix	inet,
	FramedInterfaceId	text,
	DelegatedIPv6Prefix	inet,
	Class			text
);
-- This index may be useful..
-- CREATE UNIQUE INDEX radacct_whoson on radacct (AcctStartTime, nasipaddress);

-- For use by update-, stop- and simul_* queries
CREATE INDEX radacct_active_session_idx ON radacct (AcctUniqueId) WHERE AcctStopTime IS NULL;

-- For active session checks by username (optimizes portal login queries)
CREATE INDEX radacct_active_session_username_idx ON radacct (UserName, AcctStopTime) WHERE AcctStopTime IS NULL;

-- Add if you you regularly have to replay packets
-- CREATE INDEX radacct_session_idx ON radacct (AcctUniqueId);

-- For backwards compatibility
-- CREATE INDEX radacct_active_user_idx ON radacct (AcctSessionId, UserName, NASIPAddress) WHERE AcctStopTime IS NULL;

-- For use by onoff-
CREATE INDEX radacct_bulk_close ON radacct (NASIPAddress, AcctStartTime) WHERE AcctStopTime IS NULL;

-- and for common statistic queries:
CREATE INDEX radacct_start_user_idx ON radacct (AcctStartTime, UserName);

-- and, optionally
-- CREATE INDEX radacct_stop_user_idx ON radacct (acctStopTime, UserName);

-- and for Class
CREATE INDEX radacct_calss_idx ON radacct (Class);


/*
 * Table structure for table 'radcheck'
 */
CREATE TABLE IF NOT EXISTS radcheck (
	id			serial PRIMARY KEY,
	UserName		text NOT NULL DEFAULT '',
	Attribute		text NOT NULL DEFAULT '',
	op			VARCHAR(2) NOT NULL DEFAULT '==',
	Value			text NOT NULL DEFAULT ''
);
create index radcheck_UserName on radcheck (UserName,Attribute);
/*
 * Use this index if you use case insensitive queries
 */
-- create index radcheck_UserName_lower on radcheck (lower(UserName),Attribute);

/*
 * Table structure for table 'radgroupcheck'
 */
CREATE TABLE IF NOT EXISTS radgroupcheck (
	id			serial PRIMARY KEY,
	GroupName		text NOT NULL DEFAULT '',
	Attribute		text NOT NULL DEFAULT '',
	op			VARCHAR(2) NOT NULL DEFAULT '==',
	Value			text NOT NULL DEFAULT ''
);
create index radgroupcheck_GroupName on radgroupcheck (GroupName,Attribute);

/*
 * Table structure for table 'radgroupreply'
 */
CREATE TABLE IF NOT EXISTS radgroupreply (
	id			serial PRIMARY KEY,
	GroupName		text NOT NULL DEFAULT '',
	Attribute		text NOT NULL DEFAULT '',
	op			VARCHAR(2) NOT NULL DEFAULT '=',
	Value			text NOT NULL DEFAULT ''
);
create index radgroupreply_GroupName on radgroupreply (GroupName,Attribute);

/*
 * Table structure for table 'radreply'
 */
CREATE TABLE IF NOT EXISTS radreply (
	id			serial PRIMARY KEY,
	UserName		text NOT NULL DEFAULT '',
	Attribute		text NOT NULL DEFAULT '',
	op			VARCHAR(2) NOT NULL DEFAULT '=',
	Value			text NOT NULL DEFAULT ''
);
create index radreply_UserName on radreply (UserName,Attribute);
/*
 * Use this index if you use case insensitive queries
 */
-- create index radreply_UserName_lower on radreply (lower(UserName),Attribute);

/*
 * Table structure for table 'radusergroup'
 */
CREATE TABLE IF NOT EXISTS radusergroup (
	id			serial PRIMARY KEY,
	UserName		text NOT NULL DEFAULT '',
	GroupName		text NOT NULL DEFAULT '',
	priority		integer NOT NULL DEFAULT 0
);
create index radusergroup_UserName on radusergroup (UserName);
/*
 * Use this index if you use case insensitive queries
 */
-- create index radusergroup_UserName_lower on radusergroup (lower(UserName));

--
-- Table structure for table 'radpostauth'
--

CREATE TABLE IF NOT EXISTS radpostauth (
	id			bigserial PRIMARY KEY,
	username		text NOT NULL,
	pass			text,
	reply			text,
	CalledStationId		text,
	CallingStationId	text,
	authdate		timestamp with time zone NOT NULL default now(),
	Class			text
);
CREATE INDEX radpostauth_username_idx ON radpostauth (username);
CREATE INDEX radpostauth_class_idx ON radpostauth (Class);

/*
 * Table structure for table 'nas'
 */
CREATE TABLE IF NOT EXISTS nas (
	id			serial PRIMARY KEY,
	nasname			text NOT NULL,
	shortname		text NOT NULL,
	type			text NOT NULL DEFAULT 'other',
	ports			integer,
	secret			text NOT NULL,
	server			text,
	community		text,
	description		text
);
create index nas_nasname on nas (nasname);

/*
 * Table structure for table 'nasreload'
 */
CREATE TABLE IF NOT EXISTS nasreload (
	NASIPAddress		inet PRIMARY KEY,
	ReloadTime		timestamp with time zone NOT NULL
);

/*
 * Table structure for table 'radquota'
 * Used for tracking user data quotas across all routers
 */
CREATE TABLE IF NOT EXISTS radquota (
	id			serial PRIMARY KEY,
	username		text NOT NULL,
	quota_type		text NOT NULL DEFAULT 'monthly',
	max_octets		bigint NOT NULL,
	used_octets		bigint DEFAULT 0,
	period_start		timestamp with time zone NOT NULL,
	period_end		timestamp with time zone NOT NULL,
	created_at		timestamp with time zone DEFAULT now(),
	updated_at		timestamp with time zone DEFAULT now(),
	UNIQUE(username, quota_type, period_start)
);

CREATE INDEX radquota_username_idx ON radquota(username);
CREATE INDEX radquota_period_idx ON radquota(period_end);
CREATE INDEX radquota_active_idx ON radquota(username, period_end) WHERE period_end > now();

/*
 * Function to update quota when accounting records are created/updated
 */
CREATE OR REPLACE FUNCTION update_user_quota()
RETURNS TRIGGER AS $$
DECLARE
    session_bytes bigint;
BEGIN
    -- Only update quota when session stops (acctstoptime is set)
    IF NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL THEN
        -- Calculate session bytes
        session_bytes := COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0);
        
        -- Update quota for active period
        UPDATE radquota
        SET used_octets = used_octets + session_bytes,
            updated_at = now()
        WHERE username = NEW.username
          AND period_end > now()
          AND period_start <= now();
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/*
 * Trigger to automatically update quota on session end
 */
DROP TRIGGER IF EXISTS update_quota_on_accounting ON radacct;
CREATE TRIGGER update_quota_on_accounting
AFTER UPDATE ON radacct
FOR EACH ROW
WHEN (NEW.acctstoptime IS NOT NULL AND OLD.acctstoptime IS NULL)
EXECUTE FUNCTION update_user_quota();
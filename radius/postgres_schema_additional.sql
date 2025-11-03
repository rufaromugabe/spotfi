-- Additional FreeRADIUS tables needed for PostgreSQL
-- These complement the existing radacct, radcheck, and radreply tables
-- in the Prisma schema

-- Table structure for table 'radpostauth'
CREATE TABLE IF NOT EXISTS radpostauth (
  id bigserial PRIMARY KEY,
  username text NOT NULL,
  pass text,
  reply text,
  CalledStationId text,
  CallingStationId text,
  authdate timestamp with time zone NOT NULL DEFAULT NOW(),
  Class text
);

CREATE INDEX IF NOT EXISTS radpostauth_username_idx ON radpostauth(username);
CREATE INDEX IF NOT EXISTS radpostauth_class_idx ON radpostauth(Class);

-- Table structure for table 'radgroupcheck'
CREATE TABLE IF NOT EXISTS radgroupcheck (
  id serial PRIMARY KEY,
  GroupName text NOT NULL DEFAULT '',
  Attribute text NOT NULL DEFAULT '',
  op VARCHAR(2) NOT NULL DEFAULT '==',
  Value text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS radgroupcheck_GroupName_idx ON radgroupcheck(GroupName, Attribute);

-- Table structure for table 'radgroupreply'
CREATE TABLE IF NOT EXISTS radgroupreply (
  id serial PRIMARY KEY,
  GroupName text NOT NULL DEFAULT '',
  Attribute text NOT NULL DEFAULT '',
  op VARCHAR(2) NOT NULL DEFAULT '=',
  Value text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS radgroupreply_GroupName_idx ON radgroupreply(GroupName, Attribute);

-- Table structure for table 'radusergroup'
CREATE TABLE IF NOT EXISTS radusergroup (
  id serial PRIMARY KEY,
  UserName text NOT NULL DEFAULT '',
  GroupName text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS radusergroup_UserName_idx ON radusergroup(UserName);

-- Table structure for table 'nas'
-- NAS = Network Access Server (RADIUS clients)
CREATE TABLE IF NOT EXISTS nas (
  id serial PRIMARY KEY,
  nasname text NOT NULL,
  shortname text NOT NULL,
  type text NOT NULL DEFAULT 'other',
  ports integer,
  secret text NOT NULL,
  server text,
  community text,
  description text
);

CREATE INDEX IF NOT EXISTS nas_nasname_idx ON nas(nasname);

-- Table structure for table 'nasreload'
CREATE TABLE IF NOT EXISTS nasreload (
  NASIPAddress inet PRIMARY KEY,
  ReloadTime timestamp with time zone NOT NULL
);


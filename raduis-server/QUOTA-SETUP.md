# FreeRADIUS SQL Quota Setup Guide

This guide explains how cross-router quota tracking works in SpotFi using FreeRADIUS SQL.

## Why Not Use Built-in FreeRADIUS Quota Modules?

FreeRADIUS has a built-in `rlm_sqlcounter` module for quota management, but we use a **custom hybrid approach** for these reasons:

### Built-in `rlm_sqlcounter` Module Limitations:
- ❌ **Per-NAS tracking**: Typically tracks quota per NAS/router, not cross-router
- ❌ **Limited flexibility**: Hard to customize for complex quota scenarios
- ❌ **Authentication-only**: Can only deny access during auth, not update limits dynamically
- ❌ **No dynamic limits**: Can't adjust session limits based on remaining quota
- ❌ **Period handling**: Less flexible for custom period types and expiry

### Our Custom Approach Advantages:
- ✅ **Cross-router tracking**: Single quota shared across all routers
- ✅ **Dynamic limits**: Updates `ChilliSpot-Max-Total-Octets` based on remaining quota
- ✅ **Period expiry**: Handles period expiry via `Session-Timeout` attribute
- ✅ **Automatic updates**: Database triggers update quota without application polling
- ✅ **Flexible periods**: Supports hourly, daily, weekly, monthly, or custom periods
- ✅ **Single login enforcement**: Prevents simultaneous logins across routers
- ✅ **Real-time enforcement**: NAS enforces limits locally without server dependency

## Architecture

The quota system uses a **hybrid approach** for maximum scalability:

1. **Database Layer**: `radquota` table tracks user quotas
2. **Application Layer**: Updates `radreply` table with dynamic session limits
3. **FreeRADIUS**: Reads `radreply` during authorization
4. **NAS (ChilliSpot)**: Enforces `ChilliSpot-Max-Total-Octets` and `Session-Timeout` attributes

## How It Works

### 1. Quota Storage
- Quotas are stored in `radquota` table
- Each user can have multiple quota periods (monthly, weekly, etc.)
- Quota is tracked across ALL routers (cross-router)

### 2. Quota Enforcement Flow

```
User Login → Portal API
    ↓
Check Active Session → Block if already logged in
    ↓
Check Quota (radquota table)
    ↓
Update radreply with:
  - ChilliSpot-Max-Total-Octets = remaining quota (bytes)
  - Session-Timeout = seconds until period expires
    ↓
RADIUS Authentication
    ↓
FreeRADIUS reads radreply → Returns both attributes
    ↓
NAS enforces limits:
  - Disconnects when data quota exceeded
  - Disconnects when Session-Timeout expires
```

### 3. Quota Tracking
- Database trigger `trg_update_quota` automatically updates `used_octets` when sessions are updated or end
- Trigger fires on `radacct` table `AFTER UPDATE` for both:
  - **Interim-Update packets**: Sent by uspot every 5 minutes with current usage
  - **Stop packets**: Sent when session ends
- Sums ALL sessions for the user in the current period (idempotent and self-correcting)
- Only updates active quota periods (not expired periods)
- No application-level polling needed - uspot sends updates natively, trigger handles everything automatically

## Database Schema

### radquota Table
```sql
CREATE TABLE radquota (
    id          serial PRIMARY KEY,
    username    text NOT NULL,
    quota_type  text NOT NULL DEFAULT 'monthly',
    max_octets  bigint NOT NULL,
    used_octets bigint DEFAULT 0,
    period_start timestamp with time zone NOT NULL,
    period_end   timestamp with time zone NOT NULL,
    created_at   timestamp with time zone DEFAULT now(),
    updated_at   timestamp with time zone DEFAULT now(),
    UNIQUE(username, quota_type, period_start)
);
```

### Automatic Quota Updates

The database trigger `trg_update_quota` automatically updates quota when sessions are updated (Interim-Updates) or end (Stop packets).

**Trigger Details:**
- **Function**: `update_quota_on_accounting()`
- **Trigger**: `trg_update_quota`
- **Table**: `radacct`
- **Event**: `AFTER UPDATE`
- **Condition**: Fires on any update to `radacct` when usage data is present

**What it does:**
1. Handles both Interim-Update packets (every 5 minutes) and Stop packets
2. Finds active quota period for the user
3. Sums ALL sessions for the user in the current period (idempotent and self-correcting)
4. Updates `radquota.used_octets` with the total usage
5. Only updates quotas where:
   - `period_end > now()` (period not expired)
   - `period_start <= now()` (period has started)
6. Updates `updated_at` timestamp

**Note:** The trigger uses lowercase column names (e.g., `acctstoptime`) which PostgreSQL automatically matches to the mixed-case schema columns (e.g., `AcctStopTime`) since unquoted identifiers are case-insensitive.

**Key Benefits:**
- ✅ Handles Interim-Updates (real-time quota tracking every 5 minutes)
- ✅ Handles Stop packets (final quota update on session end)
- ✅ Idempotent: Recalculates total usage, preventing double-counting
- ✅ Self-correcting: If a packet is missed, next update corrects it
- ✅ No application polling needed - uspot sends updates natively

**SQL Structure:**
```sql
CREATE OR REPLACE FUNCTION update_quota_on_accounting()
RETURNS TRIGGER AS $$
DECLARE
    period_start_ts timestamp;
    period_end_ts timestamp;
BEGIN
    -- Only process if we have usage data
    IF COALESCE(NEW.acctinputoctets, 0) + COALESCE(NEW.acctoutputoctets, 0) > 0 THEN
        -- Find active quota definition
        SELECT period_start, period_end 
        INTO period_start_ts, period_end_ts
        FROM radquota 
        WHERE username = NEW.username 
        AND period_end > now() 
        AND period_start <= now()
        LIMIT 1;

        IF FOUND THEN
            -- Update the quota usage directly from the accounting session totals
            -- We use a subquery to sum ALL sessions for this user in this period
            -- This is idempotent and self-correcting
            UPDATE radquota
            SET used_octets = (
                SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0)
                FROM radacct
                WHERE username = NEW.username
                AND acctstarttime >= period_start_ts
            ),
            updated_at = now()
            WHERE username = NEW.username 
            AND period_start = period_start_ts;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_quota
AFTER UPDATE ON radacct
FOR EACH ROW
EXECUTE FUNCTION update_quota_on_accounting();
```

## API Endpoints

### Create/Update Quota
```bash
POST /api/quota
{
  "username": "john.doe",
  "maxQuotaGB": 10,
  "quotaType": "monthly",
  "periodDays": 30
}
```

### Get Quota Info
```bash
GET /api/quota/:username
```

### Check Quota (Public)
```bash
GET /api/quota/:username/check
```

### Reset Quota
```bash
POST /api/quota/:username/reset
```

## Usage Example

### Scenario: User with 10 GB quota

1. **Create Quota**:
```bash
POST /api/quota
{
  "username": "john.doe",
  "maxQuotaGB": 10
}
```

2. **User logs in to Router A**:
   - Portal checks for active sessions: None found ✅
   - Portal checks quota: 10 GB remaining
   - Updates `radreply`:
     - `ChilliSpot-Max-Total-Octets = 10737418240` (10 GB)
     - `Session-Timeout = 2592000` (30 days in seconds)
   - User connects, uses 3 GB
   - Quota updated: 7 GB remaining

3. **User tries to log in to Router B** (while still on Router A):
   - Portal checks for active sessions: Active session found ❌
   - Login blocked: "Already logged in to another router"

4. **User disconnects from Router A, then logs in to Router B**:
   - Portal checks for active sessions: None found ✅
   - Portal checks quota: 7 GB remaining
   - Updates `radreply`:
     - `ChilliSpot-Max-Total-Octets = 7516192768` (7 GB)
     - `Session-Timeout = 2592000` (30 days remaining)
   - User connects, uses 3 GB
   - Quota updated: 4 GB remaining

5. **User logs in to Router C**:
   - Portal checks for active sessions: None found ✅
   - Portal checks quota: 4 GB remaining
   - Updates `radreply`:
     - `ChilliSpot-Max-Total-Octets = 4294967296` (4 GB)
     - `Session-Timeout = 2592000` (30 days remaining)
   - User can use remaining 4 GB

## Setup Instructions

### 1. Run Prisma Migrations

Database schema is managed by Prisma. Run migrations to create all tables:

```bash
npm run prisma:migrate:deploy
```

Prisma migrations will create:
- `radquota` table
- Database trigger for automatic quota updates (`trg_update_quota` with function `update_quota_on_accounting`)
- All required FreeRADIUS tables (radacct, radcheck, radreply, etc.)
- Indexes for performance

**Note:** No manual SQL schema file needs to be run. Prisma handles all database schema setup. All triggers and functions are managed through Prisma migrations.

### 2. Create Quota via API
```bash
curl -X POST http://localhost:8080/api/quota \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "maxQuotaGB": 10
  }'
```

### 3. Verify Quota
```bash
curl http://localhost:8080/api/quota/testuser/check
```

## How Quota Limits Are Enforced

1. **Portal Login**: 
   - Checks for active sessions (prevents simultaneous logins)
   - Updates `radreply` with:
     - `ChilliSpot-Max-Total-Octets` = remaining quota (bytes)
     - `Session-Timeout` = seconds until period expires
2. **RADIUS Auth**: FreeRADIUS reads `radreply` and returns both attributes
3. **NAS (ChilliSpot)**: Enforces both limits:
   - Disconnects when data quota (`ChilliSpot-Max-Total-Octets`) is exceeded
   - Disconnects when period expires (`Session-Timeout`)
4. **Session End**: Database trigger updates `used_octets`

## Performance

- **Scalable**: No application-level polling
- **Fast**: Database trigger updates quota immediately
- **Efficient**: Single database query per login
- **Concurrent**: Handles multiple simultaneous logins

## Troubleshooting

### Quota not enforced
1. Check `radreply` table has both attributes:
```sql
SELECT * FROM radreply WHERE username = 'testuser';
```
Should show:
- `ChilliSpot-Max-Total-Octets` = remaining quota in bytes
- `Session-Timeout` = seconds until period expires

2. Verify quota exists:
```sql
SELECT * FROM radquota WHERE username = 'testuser';
```

3. Check for active sessions (may block login):
```sql
SELECT * FROM radacct WHERE username = 'testuser' AND acctstoptime IS NULL;
```

4. Check FreeRADIUS logs for authorization queries

### Quota not updating
1. Verify database trigger exists:
```sql
SELECT * FROM pg_trigger WHERE tgname = 'trg_update_quota';
```

2. Check trigger function:
```sql
SELECT * FROM pg_proc WHERE proname = 'update_quota_on_accounting';
```

3. Verify uspot is sending Interim-Updates (check `radacct.acctupdatetime` - should update every 5 minutes)
4. Verify sessions are ending (check `radacct.acctstoptime`)

## Notes

- **Single login enforcement**: Users can only be logged in to one router at a time
- **Dual limit enforcement**: Both data quota and period expiry are enforced by NAS
  - `ChilliSpot-Max-Total-Octets`: Data limit (bytes)
  - `Session-Timeout`: Period expiry (seconds)
- Quota is enforced at the **session level** (per login)
- Each login gets a limit equal to **remaining quota**
- Period expiry is automatically handled via `Session-Timeout` attribute
- Quota is **shared across all routers**
- Database trigger ensures **real-time updates**
- No periodic checks needed - NAS handles disconnection automatically

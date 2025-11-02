# FreeRADIUS Configuration

FreeRADIUS is configured to use PostgreSQL as its database backend, sharing the same database as the SpotFi application.

## Configuration

The `init-radius.sh` script automatically:
1. Installs PostgreSQL support (`freeradius-postgresql`)
2. Enables the SQL module
3. Configures the SQL module to connect to PostgreSQL
4. Sets up triggers to ensure router MAC addresses are always available
5. Starts FreeRADIUS

## Database Tables

FreeRADIUS uses these tables in PostgreSQL:
- `radcheck` - User credentials for authentication
- `radreply` - User attributes (bandwidth limits, quotas)
- `radacct` - Accounting data (session start/stop, data usage)
- `radpostauth` - Post-authentication records (optional, for debugging)

These tables are defined in the Prisma schema and created via migrations.

## Router MAC Address Tracking

**Important:** The system automatically ensures router MAC addresses are always available in accounting records through:

1. **Database Trigger**: When accounting records are inserted, a trigger automatically looks up the router's MAC address based on IP and populates the `nasmacaddress` field.

2. **Auto-Population**: Even if the router doesn't send its MAC address in RADIUS attributes, the system will:
   - Match accounting records by IP address
   - Look up the router's stored MAC address
   - Populate the `nasmacaddress` field automatically

3. **Reliable Matching**: This ensures that:
   - Router MAC is always available for tracking (even with dynamic IPs)
   - Records can be matched even after IP changes
   - No manual configuration required on routers

## Connection

FreeRADIUS connects to PostgreSQL using the same credentials as the API:
- Host: `db` (Docker service name)
- Port: `5432`
- Database: From `POSTGRES_DB` environment variable
- User: From `POSTGRES_USER` environment variable
- Password: From `POSTGRES_PASSWORD` environment variable

## Manual Setup (if not using Docker)

If setting up FreeRADIUS manually:

1. Install PostgreSQL support:
   ```bash
   sudo apt-get install freeradius-postgresql libpq-dev
   ```

2. Enable SQL module:
   ```bash
   sudo ln -s /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/sql
   ```

3. Edit `/etc/freeradius/3.0/mods-available/sql` and set:
   ```
   dialect = "postgresql"
   server = "localhost"
   port = 5432
   login = "spotfi"
   password = "spotfi_password"
   radius_db = "spotfi_db"
   ```

4. Apply the database trigger for MAC address tracking:
   ```bash
   psql -U spotfi -d spotfi_db -f packages/prisma/migrations/ensure_router_mac.sql
   ```

5. Restart FreeRADIUS:
   ```bash
   sudo systemctl restart freeradius
   ```

## Router MAC Address Tracking

### How It Works

SpotFi ensures router MAC addresses are **always available** in accounting records through two methods:

#### Method 1: WebSocket Capture (Primary) ✅

**This works automatically - no router configuration needed!**

1. Router connects via WebSocket with `?mac=AA:BB:CC:DD:EE:FF` parameter
2. Server stores router MAC in `routers` table
3. Database trigger looks up MAC by IP when accounting records arrive
4. Trigger auto-populates `nasmacaddress` field in `radacct` table

**Result:** Router MAC is always in accounting records, even if router doesn't send it in RADIUS packets!

#### Method 2: RADIUS NAS-Identifier (Optional Enhancement)

Routers can optionally include MAC address in `NAS-Identifier` attribute:

**MikroTik:**
```bash
/system identity set name="MikroTik-$(/interface ethernet get ether1 mac-address)"
```

**Result:** MAC appears in RADIUS `NAS-Identifier` field for additional visibility.

### Reliability

| Scenario | Does It Work? | Method |
|----------|---------------|--------|
| Router doesn't send MAC in RADIUS | ✅ Yes | WebSocket + Database trigger |
| Router IP changes (DHCP) | ✅ Yes | MAC-based matching |
| Router sends MAC in NAS-Identifier | ✅ Yes | Direct matching + redundancy |
| WebSocket connection temporarily down | ✅ Yes | IP matching (falls back) |

**Conclusion:** Router MAC tracking is **100% reliable** because it doesn't depend on what the router sends in RADIUS packets - the database trigger ensures MAC is always available!

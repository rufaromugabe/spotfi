# FreeRADIUS Configuration for SpotFi

This directory contains the FreeRADIUS configuration and setup files for SpotFi.

## Files

- **Dockerfile** - Custom FreeRADIUS Docker image with PostgreSQL client
- **init-radius.sh** - Initialization script that runs on container startup
- **sql** - FreeRADIUS SQL module configuration using PostgreSQL
- **clients.conf** - RADIUS client definitions
- **postgres_schema_additional.sql** - Additional FreeRADIUS tables (radpostauth, radgroupcheck, etc.)
- **postgres_radacct_migration.sql** - Migration to add missing columns to radacct table
- **ensure_router_mac.sql** - Router MAC address tracking trigger (copied from Prisma migrations)

## How It Works

### Initialization Process

1. Wait for PostgreSQL database to be ready
2. Run SQL migrations to ensure all required FreeRADIUS tables exist
3. Configure FreeRADIUS SQL module with database connection
4. Configure RADIUS clients
5. Start FreeRADIUS server

### Database Schema

FreeRADIUS uses the following PostgreSQL tables:

- **radcheck** - User credentials (password authentication)
- **radreply** - User attributes (bandwidth limits, etc.)
- **radacct** - Accounting data (sessions, usage tracking)
- **radpostauth** - Post-authentication logging
- **radgroupcheck** - Group-based authentication checks
- **radgroupreply** - Group-based response attributes
- **radusergroup** - User-to-group mapping
- **nas** - RADIUS clients (Network Access Servers like MikroTik routers)

### Environment Variables

The configuration uses these environment variables:

- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port (default: 5432)
- `DB_USER` - PostgreSQL username
- `DB_PASS` - PostgreSQL password
- `DB_NAME` - PostgreSQL database name
- `RADIUS_SECRET` - RADIUS shared secret (default: testing123)
- `RADIUS_DEBUG` - Enable debug mode (yes/no, default: no)

### Docker Deployment

The FreeRADIUS service is defined in `docker-compose.yml`:

```yaml
freeradius:
  build:
    context: ./radius
    dockerfile: Dockerfile
  environment:
    DB_HOST: db
    DB_PORT: 5432
    DB_NAME: ${POSTGRES_DB:-spotfi_db}
    DB_USER: ${POSTGRES_USER:-spotfi}
    DB_PASSWORD: ${POSTGRES_PASSWORD:-spotfi_password}
    RADIUS_SECRET: ${RADIUS_SECRET:-testing123}
    RADIUS_DEBUG: ${RADIUS_DEBUG:-no}
  ports:
    - "1812:1812/udp"  # Authentication
    - "1813:1813/udp"  # Accounting
```

### MikroTik Router Setup

To connect a MikroTik router to this FreeRADIUS server:

1. **Add RADIUS server**:
   ```
   /ip radius add service=hotspot address=<FREERADIUS_IP> secret=<RADIUS_SECRET> 
   ```

2. **Configure hotspot profile**:
   ```
   /ip hotspot profile set hotspot1 radius=yes
   ```

3. **Register router in SpotFi**:
   - Get router ID and token from SpotFi API
   - Configure router IP address in SpotFi

### Testing RADIUS

To test the RADIUS server:

```bash
# Test authentication
radtest username password localhost 0 testing123

# Or from within the container
docker exec spotfi-radius radtest username password 127.0.0.1 0 testing123
```

### Debugging

To enable debug mode, set `RADIUS_DEBUG=yes` in environment variables:

```bash
RADIUS_DEBUG=yes docker-compose up freeradius
```

This will start FreeRADIUS in foreground mode (`-x` flag) with verbose logging.

### Viewing Logs

```bash
# FreeRADIUS logs
docker-compose logs -f freeradius

# Database connection logs
docker exec spotfi-radius freeradius -X
```

### Migrations

The initialization script runs these migrations automatically:

1. **postgres_schema_additional.sql** - Creates missing FreeRADIUS tables
2. **postgres_radacct_migration.sql** - Adds missing columns to radacct table
3. **ensure_router_mac.sql** - Sets up router MAC address tracking trigger

Migrations are idempotent and will skip if tables/columns already exist.


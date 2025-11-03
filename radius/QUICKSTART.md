# Quick Start - FreeRADIUS with PostgreSQL

This is a minimal Docker Compose setup for FreeRADIUS 3.2 with PostgreSQL.

## Prerequisites

- Docker and Docker Compose installed
- At least 1GB free disk space

## Quick Start

### 1. Create Environment File

Create a `.env` file in the project root:

```env
POSTGRES_USER=spotfi
POSTGRES_PASSWORD=spotfi_password
POSTGRES_DB=spotfi_db
RADIUS_SECRET=your-secure-secret-here
RADIUS_DEBUG=no
```

### 2. Start Services

```bash
docker-compose up -d
```

This will start:
- PostgreSQL database on port 5432
- FreeRADIUS server on ports 1812 (auth) and 1813 (accounting)

### 3. Verify Installation

```bash
# Check container status
docker-compose ps

# View FreeRADIUS logs
docker-compose logs -f freeradius

# Test RADIUS connection
radtest testuser testpass localhost 0 your-secure-secret-here
```

### 4. Check Database Tables

```bash
# Connect to database
docker exec -it spotfi-db psql -U spotfi -d spotfi_db

# List FreeRADIUS tables
\dt

# Should see: radcheck, radreply, radacct, nas, etc.
```

## Creating Test Users

```sql
-- Connect to database
docker exec -it spotfi-db psql -U spotfi -d spotfi_db

-- Create a test user
INSERT INTO radcheck (UserName, Attribute, op, Value)
VALUES ('testuser', 'Cleartext-Password', ':=', 'testpass');

-- Exit
\q
```

## Testing

### Test Authentication

```bash
radtest testuser testpass localhost 0 your-secure-secret-here

# Should return: Access-Accept
```

### View Logs

```bash
# Real-time logs
docker-compose logs -f freeradius

# Database logs
docker-compose logs -f db
```

### Enable Debug Mode

Edit `.env` file:
```env
RADIUS_DEBUG=yes
```

Restart:
```bash
docker-compose restart freeradius
```

## Connecting MikroTik Routers

Add NAS entry to database:

```sql
INSERT INTO nas (nasname, shortname, type, secret, description)
VALUES ('192.168.1.1', 'mikrotik-1', 'mikrotik', 'your-radius-secret', 'Test Router');
```

Configure MikroTik:

```bash
/ip radius add service=hotspot address=<FREERADIUS_IP> secret=your-radius-secret
/ip hotspot profile set hotspot1 radius=yes
```

## Stopping Services

```bash
docker-compose down
```

To also remove volumes (deletes all data):

```bash
docker-compose down -v
```

## Troubleshooting

### FreeRADIUS won't start

```bash
# Check logs
docker-compose logs freeradius

# Common issues:
# - Database not ready: Check db logs
# - Config error: Enable debug mode (RADIUS_DEBUG=yes)
```

### Can't connect to database

```bash
# Check database is running
docker-compose ps db

# Test connection
docker exec -it spotfi-db pg_isready -U spotfi

# View database logs
docker-compose logs db
```

### Authentication fails

```bash
# Enable debug mode
RADIUS_DEBUG=yes docker-compose restart freeradius

# Test again with verbose output
radtest testuser testpass localhost 0 secret
```

## Next Steps

- Read [FreeRADIUS Setup Guide](../docs/freeradius-setup.md) for advanced configuration
- See [MikroTik Setup](../docs/mikrotik-setup.md) for router integration
- Check [API Documentation](../docs/api.md) for SpotFi integration


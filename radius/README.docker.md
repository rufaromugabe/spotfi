# FreeRADIUS Docker Deployment (Coolify Compatible)

This directory contains a standalone FreeRADIUS server configuration compatible with Coolify and Docker Compose.

## Quick Start

### Using Docker Compose (Standalone)

```bash
# Copy environment file
cp .env.example .env.radius

# Edit .env.radius with your database credentials
nano .env.radius

# Start RADIUS server (with database)
docker-compose -f docker-compose.radius.yml --profile with-db up -d

# Or use external database (Coolify)
docker-compose -f docker-compose.radius.yml up -d
```

### Environment Variables

Required for external database (Coolify):

```bash
DB_HOST=your-database-host
DB_PORT=5432
DB_NAME=spotfi_db
DB_USER=spotfi
DB_PASSWORD=your-secure-password
RADIUS_SECRET=your-radius-secret
```

Optional:

```bash
RADIUS_AUTH_PORT=1812      # Authentication port (UDP)
RADIUS_ACCT_PORT=1813      # Accounting port (UDP)
RADIUS_DEBUG=no            # Set to 'yes' for debug logs
TZ=UTC                     # Timezone
```

## Coolify Deployment

### Method 1: Import Docker Compose File

1. In Coolify, create a new application
2. Choose "Docker Compose" as the type
3. Upload or paste the contents of `docker-compose.radius.yml`
4. Set environment variables in Coolify's environment section
5. Deploy

### Method 2: Use Coolify's Database Service

1. In Coolify, ensure you have a PostgreSQL database service
2. Note the database connection details
3. Set environment variables in `docker-compose.radius.yml`:
   ```yaml
   environment:
     DB_HOST: your-coolify-db-host
     DB_PORT: 5432
     DB_NAME: your-db-name
     DB_USER: your-db-user
     DB_PASSWORD: your-db-password
   ```
4. Remove or comment out the `db` service (since Coolify manages it)
5. Deploy

### Network Configuration

If your database is in a different Coolify network:

```yaml
networks:
  radius-network:
    external: true
    name: your-coolify-network-name
```

Or let Coolify handle networking automatically.

## Ports

- **1812/udp** - RADIUS Authentication
- **1813/udp** - RADIUS Accounting

These ports are exposed and can be mapped to different external ports via environment variables.

## Health Check

The container includes a health check that verifies FreeRADIUS is responding:

```bash
# Manual health check
docker exec spotfi-radius radtest healthcheck healthcheck 127.0.0.1 0 testing123
```

## Logs

View FreeRADIUS logs:

```bash
# Docker Compose
docker-compose -f docker-compose.radius.yml logs -f freeradius

# Docker
docker logs -f spotfi-radius

# Debug mode
docker exec spotfi-radius freeradius -X
```

## Database Setup

The FreeRADIUS server expects the following PostgreSQL tables:

- `radcheck` - User credentials
- `radreply` - User attributes
- `radacct` - Accounting records
- `radpostauth` - Post-authentication logs (optional)

These tables are managed by Prisma migrations in the main SpotFi application.

### Router MAC Tracking Trigger

The initialization script automatically applies the router MAC tracking trigger if the migration file is available. This ensures router MAC addresses are always available in accounting records.

## Persistent Volumes

- `radius_config` - FreeRADIUS configuration files
- `radius_logs` - FreeRADIUS log files
- `radius_db_data` - PostgreSQL data (if using included database)

## Troubleshooting

### Database Connection Issues

```bash
# Test database connection from container
docker exec spotfi-radius PGPASSWORD="${DB_PASSWORD}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1;"
```

### RADIUS Not Starting

```bash
# Check configuration
docker exec spotfi-radius freeradius -C

# Run in debug mode
docker-compose -f docker-compose.radius.yml run --rm -e RADIUS_DEBUG=yes freeradius
```

### Port Conflicts

Change ports via environment variables:

```bash
RADIUS_AUTH_PORT=11812
RADIUS_ACCT_PORT=11813
```

## Security Notes

1. **Change RADIUS_SECRET** - Use a strong secret shared between routers and server
2. **Network Security** - Consider restricting UDP ports to your router IPs only
3. **Database Access** - Ensure database credentials are secure and network-restricted
4. **Firewall** - Only expose RADIUS ports to trusted router IPs

## Integration with SpotFi API

When using with SpotFi:

1. Ensure both services can access the same PostgreSQL database
2. Set `DB_HOST` to point to the shared database
3. Both services will share the same `radacct`, `radcheck`, and `radreply` tables
4. Router MAC tracking will work automatically via database triggers


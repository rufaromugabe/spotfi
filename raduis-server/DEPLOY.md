# FreeRADIUS Deployment Guide for Coolify

## Problem Fixed

The original configuration used **volume mounts** for `docker-entrypoint.sh`, which caused deployment failures on Coolify with this error:
```
error mounting "/data/coolify/.../docker-entrypoint.sh" to rootfs: not a directory
```

## Solution

Created a **Dockerfile** that builds the entrypoint script and SQL configuration **into the image** instead of mounting them as volumes.

## What Changed

### Before (Volume Mounts - ❌ Fails on Coolify)
```yaml
image: freeradius/freeradius-server:latest
volumes:
  - ./sql:/etc/freeradius/mods-available/sql
  - ./docker-entrypoint.sh:/docker-entrypoint.sh
```

### After (Build from Dockerfile - ✅ Works on Coolify)
```yaml
build:
  context: .
  dockerfile: Dockerfile
```

## Deployment Steps for Coolify

### 1. Set Environment Variables in Coolify

Configure these environment variables in your Coolify application:

```bash
DB_HOST=your-postgres-host
DB_PORT=5432
DB_NAME=radius
DB_USER=radius
DB_PASS=your-database-password
DB_DIALECT=postgresql
```

### 2. Deploy from Git Repository

1. Push your code to Git (GitHub, GitLab, etc.)
2. In Coolify, create a new application
3. Select "Docker Compose" as the build pack
4. Point to your repository
5. Set the base directory to `raduis-server`
6. Add the environment variables listed above
7. Deploy!

### 3. Verify Deployment

Check the logs in Coolify. You should see:
```
Ready to process requests
Listening on auth address * port 1812
Listening on acct address * port 1813
```

### 4. Test Authentication (Optional)

From within the container:
```bash
radtest testuser testpass localhost 0 testing123
```

Expected response: `Access-Accept`

## Files Included in Image

The Dockerfile copies these files into the image:
- `docker-entrypoint.sh` - Custom entrypoint script
- `sql/` - FreeRADIUS SQL module configuration

## Ports Exposed

- `1812/udp` - RADIUS Authentication
- `1813/udp` - RADIUS Accounting

## Local Testing

Test locally before deploying:
```bash
docker-compose up -d --build
docker logs freeradius
docker exec freeradius radtest testuser testpass localhost 0 testing123
```

## Troubleshooting

### Container keeps restarting
- Check database connection settings
- Verify the database is accessible from the container
- Check logs: `docker logs freeradius`

### Cannot connect to RADIUS server
- Ensure ports 1812 and 1813 are properly exposed
- Check firewall rules
- Verify NAS/client is configured with correct shared secret

### SQL module not loading
- Verify database credentials are correct
- Ensure Prisma migrations have been run (creates all database tables including FreeRADIUS tables)
- Review FreeRADIUS logs for SQL connection errors

## Database Setup

**Note:** Database schema is managed by Prisma migrations. Before deploying FreeRADIUS, ensure Prisma migrations have been run:

```bash
npm run prisma:migrate:deploy
```

Prisma migrations will create all required FreeRADIUS tables:
- `radacct` - RADIUS accounting records
- `radcheck` - RADIUS user check attributes
- `radreply` - RADIUS user reply attributes
- `radusergroup` - RADIUS user group assignments
- `radgroupcheck` - RADIUS group check attributes
- `radgroupreply` - RADIUS group reply attributes
- `radpostauth` - RADIUS post-authentication records
- `nas` - Network Access Server (router) definitions
- `radquota` - User quota tracking

No manual schema initialization is needed.


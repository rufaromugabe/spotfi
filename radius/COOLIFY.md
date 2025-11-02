# Coolify Deployment Guide

Quick guide for deploying FreeRADIUS server on Coolify.

## Method 1: Import Docker Compose File (Recommended)

1. **In Coolify Dashboard:**
   - Go to your server/project
   - Click "New Resource" → "Docker Compose"
   - Paste the contents of `docker-compose.radius.yml`

2. **Set Environment Variables:**
   ```bash
   # Database (use Coolify's database service connection details)
   DB_HOST=your-coolify-db.internal
   DB_PORT=5432
   POSTGRES_DB=spotfi_db
   POSTGRES_USER=spotfi
   POSTGRES_PASSWORD=your-secure-password
   
   # RADIUS Configuration
   RADIUS_SECRET=your-strong-secret-here
   RADIUS_DEBUG=no
   
   # Ports (optional, Coolify can handle port mapping)
   RADIUS_AUTH_PORT=1812
   RADIUS_ACCT_PORT=1813
   ```

3. **Remove Database Service:**
   - Since Coolify manages your database, remove or comment out the `db` service
   - Or keep it but it won't start (profiled as `with-db`)

4. **Network Configuration:**
   - If your database is in a Coolify network, update:
     ```yaml
     networks:
       radius-network:
         external: true
         name: your-coolify-network
     ```

5. **Deploy!**

## Method 2: Git Repository Deployment

1. **Push code to Git:**
   ```bash
   git add docker-compose.radius.yml radius/
   git commit -m "Add standalone RADIUS server"
   git push
   ```

2. **In Coolify:**
   - Connect your Git repository
   - Select the repository
   - Choose "Docker Compose" as build pack
   - Set the compose file path: `docker-compose.radius.yml`
   - Set environment variables
   - Deploy

## Method 3: Custom Dockerfile

If you prefer using a Dockerfile directly:

1. In Coolify, create a new application
2. Set build pack to "Dockerfile"
3. Set Dockerfile path to: `radius/Dockerfile`
4. Set build context to: `radius/`
5. Set environment variables (same as Method 1)
6. Expose ports: `1812/udp` and `1813/udp`
7. Deploy

## Environment Variables Reference

### Required

```bash
DB_HOST=              # Your PostgreSQL host (from Coolify database service)
DB_PORT=5432          # PostgreSQL port
POSTGRES_DB=          # Database name
POSTGRES_USER=        # Database user
POSTGRES_PASSWORD=    # Database password
RADIUS_SECRET=        # Shared secret between routers and RADIUS server
```

### Optional

```bash
RADIUS_DEBUG=no                    # Set to 'yes' for verbose logging
RADIUS_AUTH_PORT=1812              # Authentication port (UDP)
RADIUS_ACCT_PORT=1813              # Accounting port (UDP)
RADIUS_CONTAINER_NAME=spotfi-radius
TZ=UTC                             # Timezone
```

## Network Configuration

### Using Coolify's Internal Network

If your database is in Coolify's internal network:

```yaml
networks:
  radius-network:
    external: true
    name: coolify-internal
```

### Using Public Network

For external database access:

```yaml
networks:
  radius-network:
    driver: bridge
    name: radius-network
```

Then ensure your database allows connections from Coolify's network.

## Port Configuration

Coolify automatically handles port mapping. You can:

1. **Use default ports:** Let Coolify map ports automatically
2. **Set custom ports:** Use environment variables `RADIUS_AUTH_PORT` and `RADIUS_ACCT_PORT`
3. **Use Coolify port management:** Configure ports in Coolify's service settings

## Health Checks

The container includes health checks. Coolify will show service status based on:

- Database connectivity
- FreeRADIUS service responsiveness
- RADIUS authentication test

## Persistent Storage

Coolify automatically manages volumes. The following are persisted:

- `/etc/freeradius/3.0` - Configuration files
- `/var/log/freeradius` - Log files

## Integration with SpotFi API

When deploying alongside SpotFi API:

1. **Shared Database:** Both services should point to the same PostgreSQL database
2. **Environment Variables:** Use the same database credentials
3. **Network:** Ensure services can communicate (Coolify handles this)
4. **Tables:** SpotFi API migrations create required RADIUS tables

## Troubleshooting

### Service Won't Start

1. **Check logs:**
   ```bash
   # In Coolify, view service logs
   ```

2. **Verify database connection:**
   - Check `DB_HOST` is accessible from Coolify network
   - Verify database credentials
   - Test connection from another service

3. **Check health check:**
   - Review health check logs
   - Verify `RADIUS_SECRET` matches what's configured

### Port Issues

1. **UDP ports:** Ensure ports 1812 and 1813 are open
2. **Firewall:** Check Coolify server firewall rules
3. **Port conflicts:** Verify no other service uses these ports

### Database Connection Failed

1. **Network:** Ensure database is accessible from Coolify network
2. **Credentials:** Double-check database user/password
3. **SSL:** If database requires SSL, add to connection string:
   ```bash
   DB_SSL_MODE=require
   ```

## Quick Start Command

For testing locally before Coolify deployment:

```bash
# Copy environment example
cp radius/env.example .env.radius

# Edit with your values
nano .env.radius

# Start with database
docker-compose -f docker-compose.radius.yml --profile with-db up -d

# Or use external database (like Coolify)
docker-compose -f docker-compose.radius.yml up -d
```

## Support

For issues:
1. Check service logs in Coolify
2. Review `radius/README.docker.md` for detailed documentation
3. Enable debug mode: `RADIUS_DEBUG=yes`


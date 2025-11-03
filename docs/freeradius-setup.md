# FreeRADIUS Setup Guide for SpotFi

This guide explains how to set up and use FreeRADIUS with SpotFi for authentication and accounting.

## Overview

SpotFi uses FreeRADIUS 3.2 with PostgreSQL for:
- **Authentication**: Verifying user credentials
- **Authorization**: Checking user permissions and attributes
- **Accounting**: Tracking user sessions and data usage

## Architecture

```
┌─────────────────────┐
│   MikroTik Router   │
│  (RADIUS Client)    │
└──────────┬──────────┘
           │
           │ RADIUS (1812/udp, 1813/udp)
           ▼
┌─────────────────────┐
│   FreeRADIUS 3.2    │
│   (AAA Server)      │
└──────────┬──────────┘
           │
           │ PostgreSQL
           ▼
┌─────────────────────┐
│   PostgreSQL DB     │
│  (SpotFi + RADIUS)  │
└─────────────────────┘
```

## Quick Start

### 1. Start FreeRADIUS with Docker Compose

```bash
# Start all services (database, FreeRADIUS, API)
docker-compose up -d

# Check logs
docker-compose logs -f freeradius

# Verify FreeRADIUS is running
docker-compose ps freeradius
```

### 2. Configure Environment Variables

Create a `.env` file with these variables:

```env
# Database
POSTGRES_USER=spotfi
POSTGRES_PASSWORD=spotfi_password
POSTGRES_DB=spotfi_db

# FreeRADIUS
RADIUS_SECRET=your-secure-secret-here
RADIUS_DEBUG=no

# API
JWT_SECRET=your-jwt-secret
PORT=8080
```

### 3. Test FreeRADIUS Connection

```bash
# From host machine
radtest testuser testpass localhost 0 your-secure-secret-here

# From inside container
docker exec spotfi-radius radtest testuser testpass 127.0.0.1 0 your-secure-secret-here
```

## Database Schema

FreeRADIUS uses these PostgreSQL tables:

### Authentication Tables

- **radcheck**: User credentials (password, check attributes)
- **radreply**: User response attributes (bandwidth limits, quotas, etc.)
- **radgroupcheck**: Group-based authentication checks
- **radgroupreply**: Group-based response attributes
- **radusergroup**: User-to-group mapping

### Accounting Tables

- **radacct**: Session accounting data (start/stop, octets, duration, etc.)
- **radpostauth**: Post-authentication logging

### NAS Tables

- **nas**: RADIUS clients (Network Access Servers like MikroTik routers)

### SpotFi Custom

- **routers**: SpotFi router management
- **radacct.nasmacaddress**: Router MAC address (auto-populated via trigger)

## Creating RADIUS Users

### Method 1: Direct Database Insert

```sql
-- Create a user with cleartext password
INSERT INTO radcheck (UserName, Attribute, op, Value)
VALUES ('user1', 'Cleartext-Password', ':=', 'password123');

-- Add bandwidth limit for the user
INSERT INTO radreply (UserName, Attribute, op, Value)
VALUES ('user1', 'Mikrotik-Rate-Limit', '=', '10M/10M');

-- Add download limit
INSERT INTO radreply (UserName, Attribute, op, Value)
VALUES ('user1', 'WISPr-Bandwidth-Max-Down', '=', '10485760');
```

### Method 2: Using SpotFi API (Recommended)

Create users through the SpotFi management interface or API.

### Method 3: Group-Based Users

```sql
-- Create a group
INSERT INTO radgroupcheck (GroupName, Attribute, op, Value)
VALUES ('premium_users', 'Auth-Type', ':=', 'Accept');

INSERT INTO radgroupreply (GroupName, Attribute, op, Value)
VALUES ('premium_users', 'Mikrotik-Rate-Limit', '=', '50M/50M');

-- Assign user to group
INSERT INTO radusergroup (UserName, GroupName, priority)
VALUES ('user1', 'premium_users', 1);
```

## MikroTik Router Configuration

### 1. Register Router in SpotFi

First, create a router in SpotFi to get the router ID and NAS IP address.

### 2. Configure RADIUS on MikroTik

```bash
# Add FreeRADIUS server
/ip radius add service=hotspot address=<FREERADIUS_IP> secret=<RADIUS_SECRET> 

# Or add multiple services
/ip radius add service=login,hotspot,web address=<FREERADIUS_IP> secret=<RADIUS_SECRET>

# Enable RADIUS on hotspot profile
/ip hotspot profile set hotspot1 radius=yes

# Enable RADIUS accounting
/ip radius accounting set enabled=yes
```

### 3. Add NAS Entry to FreeRADIUS

```sql
-- Add MikroTik router as NAS (RADIUS client)
INSERT INTO nas (nasname, shortname, type, secret, description)
VALUES ('10.10.10.1', 'router-1', 'mikrotik', 'your-radius-secret', 'MikroTik Router 1');
```

## Monitoring and Debugging

### View Real-Time Logs

```bash
# FreeRADIUS logs
docker-compose logs -f freeradius

# Last 100 lines
docker-compose logs --tail=100 freeradius
```

### Enable Debug Mode

```bash
# Set RADIUS_DEBUG=yes in .env file
RADIUS_DEBUG=yes

# Restart container
docker-compose restart freeradius

# Or run in foreground with debug
docker exec -it spotfi-radius freeradius -X
```

### Check Database Connections

```bash
# View active accounting sessions
SELECT username, nasipaddress, acctstarttime, acctsessiontime 
FROM radacct 
WHERE acctstoptime IS NULL;

# View recent authentication attempts
SELECT username, reply, authdate 
FROM radpostauth 
ORDER BY authdate DESC 
LIMIT 20;

# View accounting data for a user
SELECT username, acctstarttime, acctstoptime, 
       acctinputoctets + acctoutputoctets as total_bytes,
       acctsessiontime
FROM radacct 
WHERE username = 'user1'
ORDER BY acctstarttime DESC;
```

### Health Check

```bash
# Check if FreeRADIUS is responding
docker exec spotfi-radius radtest healthcheck healthcheck 127.0.0.1 0 testing123

# Should return: Access-Accept
```

## Common Issues

### Issue: "Could not connect to database"

**Solution**: Check database connection settings and ensure PostgreSQL is running:

```bash
# Check database
docker-compose ps db

# View database logs
docker-compose logs db

# Verify network connectivity
docker exec spotfi-radius pg_isready -h db -p 5432
```

### Issue: "User authentication fails"

**Solution**: Check user credentials and debug mode:

```bash
# Enable debug
RADIUS_DEBUG=yes docker-compose restart freeradius

# Test with debug output
radtest username password localhost 0 secret

# Check logs for errors
docker-compose logs freeradius | grep -i error
```

### Issue: "Accounting data not recorded"

**Solution**: Verify NAS entry and accounting configuration:

```bash
# Check NAS table
SELECT * FROM nas;

# Check recent accounting records
SELECT * FROM radacct ORDER BY acctstarttime DESC LIMIT 10;

# Verify accounting is enabled on MikroTik
/ip radius accounting print
```

## Advanced Configuration

### Custom Attributes

FreeRADIUS supports custom RADIUS attributes for MikroTik:

```sql
-- Rate limiting
'Mikrotik-Rate-Limit' = '10M/10M'

-- Time-based access
'Mikrotik-Group' = 'evening-users'

-- VLAN assignment
'Tunnel-Type' = 'VLAN'
'Tunnel-Medium-Type' = 'IEEE-802'
'Tunnel-Private-Group-Id' = '100'

-- IP pool
'Framed-Pool' = 'hotspot-pool'
```

### Multiple Virtual Servers

You can create multiple virtual servers for different purposes:

```bash
# Create custom virtual server
docker exec -it spotfi-radius bash
cd /etc/freeradius/3.0/sites-enabled
cp default admin-users
```

### Load Balancing

For high availability, deploy multiple FreeRADIUS instances behind a load balancer.

## Performance Tuning

### Connection Pooling

Adjust pool settings in `radius/sql`:

```bash
pool {
    start = 10      # Initial connections
    min = 5         # Minimum connections
    max = 20        # Maximum connections
    spare = 5       # Spare connections
    idle_timeout = 60
}
```

### Database Indexes

FreeRADIUS performance depends on proper database indexes. The schema includes these indexes:

- `radacct(username, acctstarttime)`
- `radcheck(username, attribute)`
- `radreply(username, attribute)`
- `nas(nasname)`

## Security Best Practices

1. **Change default secrets**: Use strong, unique RADIUS secrets
2. **Disable debug mode**: Keep `RADIUS_DEBUG=no` in production
3. **Use encrypted passwords**: Consider MD5 or SHA1 password hashing instead of cleartext
4. **Limit NAS access**: Only add trusted routers to the `nas` table
5. **Regular backups**: Backup the PostgreSQL database regularly
6. **Monitor logs**: Set up log rotation and monitoring

## Integration with SpotFi

### Usage Tracking

SpotFi automatically syncs RADIUS accounting data:

- **Hourly**: Updates `router.totalUsage` from `radacct` table
- **Monthly**: Generates invoices based on usage
- **Real-time**: Updates router online/offline status

### API Integration

Use SpotFi API to manage RADIUS users and track usage:

```bash
# Get router accounting data
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/routers/$ROUTER_ID/stats

# View usage analytics
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/invoices
```

## Additional Resources

- [FreeRADIUS Documentation](https://freeradius.org/documentation/)
- [MikroTik RADIUS Guide](https://wiki.mikrotik.com/wiki/Manual:RADIUS)
- [SpotFi Router Setup](mikrotik-setup.md)
- [SpotFi API Documentation](api.md)


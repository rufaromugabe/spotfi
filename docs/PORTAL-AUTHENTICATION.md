# Portal Authentication - How Router Secrets Are Retrieved

This document explains how the captive portal authenticates users and retrieves router-specific RADIUS secrets.

## Overview

The portal needs to identify which router is making the authentication request to use the correct RADIUS secret. Each router has its own unique RADIUS secret stored in the database.

## How It Works

### 1. Router Creation & Secret Generation

When a router is created via `POST /api/routers`:

```typescript
// apps/api/src/routes/routers.ts
const router = await prisma.router.create({
  data: {
    name: body.name,
    hostId: body.hostId,
    token: randomBytes(32).toString('hex'),      // WebSocket token
    radiusSecret: randomBytes(16).toString('hex'), // RADIUS secret (32 hex chars)
    macAddress: formattedMac,
    location: body.location,
    status: 'OFFLINE'
  }
});
```

**Generated values:**
- `router.id` - Unique router ID (used as NAS ID)
- `router.radiusSecret` - 32-character hex string for RADIUS authentication
- `router.token` - WebSocket authentication token (separate from RADIUS)

### 2. CoovaChilli Configuration

The OpenWRT setup script configures CoovaChilli with:

```bash
# /etc/chilli/config
HS_NASID=$ROUTER_ID           # Router ID (router.id from database)
HS_RADSECRET=$RADIUS_SECRET    # RADIUS secret (router.radiusSecret)
HS_UAMSERVER=https://api.spotfi.com/portal  # Portal URL
```

**Important:** The `HS_NASID` is set to the router's ID, which should be passed to the portal as `nasid` query parameter.

### 3. Portal Router Identification

When a user tries to connect to WiFi, CoovaChilli redirects them to:

```
https://api.spotfi.com/portal?uamip=10.1.0.1&uamport=3990&challenge=XXX&called=MAC&mac=MAC&ip=CLIENT_IP&nasid=ROUTER_ID&userurl=http://www.google.com
```

The portal uses multiple methods to identify the router (in order of priority):

#### Method 1: NAS ID (Most Reliable)
```typescript
// If nasid query parameter is provided (matches router.id)
if (nasid) {
  router = await prisma.router.findUnique({
    where: { id: nasid }
  });
}
```

#### Method 2: IP Address from Query
```typescript
// If IP query parameter is provided (matches router.nasipaddress)
if (!router && ip) {
  router = await prisma.router.findFirst({
    where: { nasipaddress: ip }
  });
}
```

#### Method 3: Request IP Address
```typescript
// Use the actual request IP (router's public IP)
const requestIp = request.ip || request.headers['x-forwarded-for'];
if (!router && requestIp) {
  router = await prisma.router.findFirst({
    where: { nasipaddress: requestIp }
  });
}
```

#### Method 4: MAC Address (Fallback)
```typescript
// If MAC address is provided (matches router.macAddress)
if (!router && mac) {
  router = await prisma.router.findFirst({
    where: { macAddress: formattedMac }
  });
}
```

### 4. Using the RADIUS Secret

Once the router is identified:

```typescript
// Get RADIUS secret from router record
const radiusSecret = router.radiusSecret;  // From database

// Authenticate user via RADIUS
const radClient = new RadClient({
  host: RADIUS_HOST,        // RADIUS server IP (from env or router config)
  secret: radiusSecret,      // Router-specific secret from database
  port: 1812
});

const authResult = await radClient.authenticate(username, password, {
  'NAS-IP-Address': ip,
  'NAS-Identifier': router.id,  // Router ID
  'User-Name': username,
  // ... other attributes
});
```

## Important Notes

### Router IP vs RADIUS Server IP

**Common confusion:**
- **Router IP** (`router.nasipaddress`) - The router's public IP address (used to identify which router)
- **RADIUS Server IP** (`RADIUS_HOST` env var) - The FreeRADIUS server IP (where authentication happens)

These are **different**:
- Router IP identifies **which router** is making the request
- RADIUS Server IP is **where** the authentication request goes

```typescript
// Router IP - used to identify router
const routerIp = router.nasipaddress;  // e.g., "203.0.113.45"

// RADIUS Server IP - used for authentication
const radiusHost = process.env.RADIUS_HOST || '127.0.0.1';  // FreeRADIUS server
```

### Why Multiple Identification Methods?

CoovaChilli might not always pass the NAS ID as a query parameter. Using multiple methods ensures the router can be identified even if:
- NAS ID is missing from the request
- Router's IP changed (by matching MAC address)
- Request comes through a proxy (using X-Forwarded-For header)

## Setup Requirements

### 1. Router Must Be Registered

Before users can authenticate, ensure:
- Router is created via `POST /api/routers`
- Router has a `radiusSecret` in the database
- Router's `nasipaddress` is set (when router connects via WebSocket)

### 2. Environment Variables

```bash
# .env file
RADIUS_HOST=192.168.1.100  # FreeRADIUS server IP (required)
RADIUS_PORT=1812           # RADIUS auth port (default: 1812)
```

### 3. CoovaChilli Configuration

The setup script automatically configures:
- `HS_NASID` - Router ID (should match `router.id`)
- `HS_RADSECRET` - RADIUS secret (should match `router.radiusSecret`)
- `HS_UAMSERVER` - Portal URL

## Troubleshooting

### "Router not found" Error

**Possible causes:**
1. Router not registered in database
2. Router's `nasipaddress` not set
3. NAS ID doesn't match router ID
4. IP address mismatch

**Debug steps:**
1. Check router exists: `GET /api/routers/:id`
2. Verify router has `radiusSecret`
3. Check router's `nasipaddress` matches the request IP
4. Review portal logs for router identification attempts

### "Invalid router configuration" Error

**Possible causes:**
1. Router exists but missing `radiusSecret`
2. Router identification failed

**Debug steps:**
1. Check router record in database
2. Verify `radiusSecret` is not null
3. Review portal logs for identification method used

## Security Considerations

1. **Secret Storage**: RADIUS secrets are stored in the database and should be kept secure
2. **Secret Rotation**: Currently, secrets are generated once. Consider implementing rotation
3. **Router Validation**: Always validate router exists before using its secret
4. **Logging**: Log authentication attempts but never log passwords or full secrets

## Future Improvements

1. **Router-specific RADIUS hosts**: Store RADIUS server IP per router instead of global env var
2. **Secret rotation**: Allow rotating RADIUS secrets without recreating router
3. **Caching**: Cache router lookups to reduce database queries
4. **Better error messages**: Provide more specific errors for different failure scenarios


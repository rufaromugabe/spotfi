# Uspot Portal Authentication Flow

This document explains how portal authentication works with uspot after removing CoovaChilli support.

## Overview

The portal authentication flow uses uspot (OpenWRT captive portal) with external RADIUS authentication. The portal acts as a web interface that authenticates users via RADIUS and redirects them back to their destination.

## Complete Flow

### 1. User Connects to WiFi

When a user connects to the WiFi network:
- Uspot intercepts the connection
- User is redirected to the portal URL configured in uspot

### 2. Uspot Redirects to Portal

Uspot redirects the user to:
```
https://api.spotfi.com/portal?nasid=ROUTER_ID&ip=CLIENT_IP&userurl=http://www.google.com
```

**Parameters sent by uspot:**
- `nasid` - Router ID (from `nas_id` in uspot config) - **REQUIRED**
- `ip` - Client's IP address on the hotspot network (e.g., 10.1.0.50) - **RECOMMENDED** (more accurate than request IP)
- `userurl` - Original destination URL the user was trying to access - **OPTIONAL** (defaults to `http://www.google.com`)

### 3. Portal Displays Login Page

The portal (`GET /portal`) receives the request and:
1. Extracts query parameters: `nasid`, `ip`, `userurl`
2. Displays a login form with hidden fields containing these parameters
3. User enters username and password

### 4. User Submits Credentials

When the user submits the form (`POST /portal/login`):
1. Portal receives: `username`, `password`, `nasid`, `ip`, `userurl`
2. Portal identifies the router by **router ID only**:
   - **Required**: `nasid` parameter must match `router.id`
   - If `nasid` is missing, authentication fails with error
   - If router not found by `nasid`, authentication fails with error

### 5. RADIUS Authentication

Once the router is identified:
1. Portal retrieves `router.radiusSecret` from database
2. Portal sends RADIUS Access-Request to FreeRADIUS server:
   - Uses `RADIUS_HOST` env var (or router's IP as fallback)
   - Uses router's unique `radiusSecret`
   - Includes attributes:
     - `NAS-IP-Address`: Client IP (from router/uspot, more accurate than request IP)
     - `NAS-Identifier`: Router ID (nasid)
     - `Called-Station-Id`: Empty (not provided)
     - `Calling-Station-Id`: Empty (not provided)
     - `User-Name`: Username

### 6. Authentication Result

**If authentication succeeds:**
- Portal redirects user directly to `userurl` (their original destination)
- Uspot handles session management internally
- User can now browse the internet

**If authentication fails:**
- Portal displays error message
- User can retry login

## Key Differences from CoovaChilli

| Aspect | CoovaChilli (Removed) | Uspot (Current) |
|--------|---------------------|-----------------|
| Redirect after auth | Redirects to UAM server `/logon` endpoint | Direct redirect to `userurl` |
| Parameters | `uamip`, `uamport`, `challenge`, `called` | `nasid`, `ip`, `mac`, `userurl` |
| Session management | Portal redirects to UAM server | Uspot handles internally |
| Authentication | Portal authenticates, then redirects to UAM | Portal authenticates, then redirects to destination |

## Router Identification

The portal uses **router ID only** to identify the router:

1. **NAS ID (Required)**: `nasid` parameter must match `router.id`
   - If `nasid` is missing, authentication fails immediately
   - Router must be registered in database with matching `id`
   - Router must have a valid `radiusSecret`

**Important**: The `nasid` parameter is mandatory. Uspot must be configured with `nas_id=$ROUTER_ID` to send the correct router ID.

## Configuration Requirements

### Router Setup (via uspot script)

```bash
# Router must be configured with:
uci set uspot.@instance[0].nas_id="$ROUTER_ID"
uci set uspot.@instance[0].portal_url="https://api.spotfi.com/portal"
uci set uspot.@instance[0].radius_secret="$RADIUS_SECRET"
uci set uspot.@instance[0].radius_auth_server="$RADIUS_IP"
```

### Database Requirements

Router must have:
- `id` - Router ID (used as NAS ID) - **REQUIRED**
- `radiusSecret` - Unique RADIUS secret for this router - **REQUIRED**

### Environment Variables

```bash
RADIUS_HOST=192.168.1.100  # FreeRADIUS server IP
RADIUS_PORT=1812           # RADIUS auth port (default: 1812)
```

## Example Flow

```
1. User connects to WiFi
   ↓
2. Uspot intercepts → Redirects to:
   https://api.spotfi.com/portal?nasid=abc123&ip=10.1.0.50&userurl=http://www.google.com
   ↓
3. Portal displays login page
   ↓
4. User enters credentials → POST /portal/login
   ↓
5. Portal finds router by nasid="abc123"
   ↓
6. Portal authenticates via RADIUS using router's radiusSecret
   ↓
7. If success → Redirect to http://www.google.com
   ↓
8. User can browse internet (uspot manages session)
```

## Troubleshooting

### "Router not found" Error

**Possible causes:**
1. Router not registered in database
2. `nasid` parameter doesn't match `router.id`
3. `nasid` parameter is missing from request

**Solutions:**
- Verify router exists: `GET /api/routers/:id`
- Check that uspot config has `nas_id` set to the router's ID
- Verify uspot is sending `nasid` parameter in portal redirect URL
- Check portal logs for the exact `nasid` value received

### "Missing router identifier" Error

**Possible causes:**
1. Uspot not configured with `nas_id`
2. Uspot not sending `nasid` parameter in redirect

**Solutions:**
- Verify uspot config: `uci show uspot | grep nas_id`
- Check uspot config has `nas_id` set to router's ID
- Restart uspot: `/etc/init.d/uspot restart`
- Check uspot logs: `logread | grep uspot`

### "Invalid router configuration" Error

**Possible causes:**
1. Router exists but missing `radiusSecret`

**Solutions:**
- Check router record in database
- Verify `radiusSecret` is not null
- Recreate router if `radiusSecret` is missing

### Authentication Fails

**Possible causes:**
1. Wrong RADIUS server IP
2. Wrong RADIUS secret
3. User credentials invalid
4. RADIUS server unreachable

**Solutions:**
- Verify `RADIUS_HOST` env var is correct
- Check router's `radiusSecret` matches RADIUS config
- Verify user exists in RADIUS database
- Test RADIUS connectivity from portal server

## Security Considerations

1. **HTTPS Required**: Portal should be accessed via HTTPS in production
2. **Secret Storage**: RADIUS secrets stored in database (keep secure)
3. **Router Validation**: Always validate router exists before using secret
4. **Logging**: Log authentication attempts but never log passwords or full secrets


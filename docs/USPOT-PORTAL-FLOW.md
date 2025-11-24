# Uspot Portal Authentication Flow

This document explains how portal authentication works with uspot.

## Overview

The portal authentication flow uses **standard UAM (Universal Access Method)** where:
- **Cloud Portal** serves only the UI (login form)
- **Router (uspot)** handles RADIUS authentication and firewall management

## Complete Flow

### 1. User Connects to WiFi

When a user connects to the WiFi network:
- Uspot intercepts the connection
- User is redirected to the portal URL configured in uspot

### 2. Uspot Redirects to Portal

Uspot redirects the user to:
```
https://api.spotfi.com/portal?nasid=ROUTER_ID&uamip=192.168.56.10&uamport=80&userurl=http://www.google.com
```

**Parameters sent by uspot:**
- `nasid` - Router ID (from `nas_id` in uspot config) - **OPTIONAL** (for display purposes)
- `uamip` - Router's UAM IP address (gateway IP on hotspot network, e.g., 192.168.56.10) - **REQUIRED**
  - This is the **local IP address** of the router on the hotspot network
  - The form must submit to this local IP so the router can receive credentials directly
- `uamport` - Router's UAM port (default: 80) - **OPTIONAL** (defaults to 80)
- `userurl` - Original destination URL the user was trying to access - **OPTIONAL** (defaults to `http://www.google.com`)

### 3. Portal Displays Login Page

The portal (`GET /portal`) receives the request and:
1. Extracts query parameters: `nasid`, `uamip`, `uamport`, `userurl`
2. **Validates that `uamip` is present** - if missing, shows error (user accessed portal directly)
3. Constructs form action URL: `http://<uamip>:<uamport>/login`
   - **Important**: This is the router's **local IP address** on the hotspot network (e.g., `192.168.56.10`)
   - The form submits directly to the router, not to the cloud API
   - This allows the router to receive credentials and perform RADIUS authentication locally
4. Displays a login form with hidden fields containing these parameters
5. User enters username and password

### 4. User Submits Credentials

When the user submits the form:
- **Form submits directly to Router's local IP**: `POST http://<uamip>:<uamport>/login`
  - Example: `POST http://192.168.56.10:80/login` (router's gateway IP on hotspot network)
  - **Why local IP?** The user is on the hotspot network, and the router's uspot service listens on this local IP
  - The router must receive credentials directly to perform RADIUS auth and control the firewall
- **Router (uspot) receives**: `username`, `password`, `uamip`, `uamport`, `userurl`
- **Router performs RADIUS authentication** against FreeRADIUS server
- **Router opens firewall** if authentication succeeds
- **Router redirects user** to `userurl` (success) or back to portal with error

### 5. Authentication Result

**If authentication succeeds:**
- Router opens firewall for the user
- Router redirects user to `userurl` (their original destination)
- User can now browse the internet

**If authentication fails:**
- Router redirects user back to portal with error parameter
- Portal displays error message
- User can retry login

## Standard UAM Flow

The new architecture follows the **standard UAM (Universal Access Method) flow**:

```
Browser (Cloud UI) 
  → POST http://<uamip>:<uamport>/login 
  → Router sends RADIUS Request 
  → Router opens Firewall 
  → Router redirects to Success URL
```

This is the industry-standard approach used by all major captive portal solutions.

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

**Note:** The Cloud API does not need `RADIUS_HOST` or `RADIUS_PORT` environment variables since it does not perform RADIUS authentication.

## Example Flow

```
1. User connects to WiFi
   ↓
2. Uspot intercepts → Redirects to:
   https://api.spotfi.com/portal?nasid=abc123&uamip=192.168.56.10&uamport=80&userurl=http://www.google.com
   ↓
3. Portal displays login page
   Form action: http://192.168.56.10:80/login
   ↓
4. User enters credentials → POST http://192.168.56.10:80/login
   ↓
5. Router (uspot) receives credentials
   ↓
6. Router sends RADIUS Access-Request to FreeRADIUS
   ↓
7. If RADIUS accepts → Router opens firewall
   ↓
8. Router redirects to http://www.google.com
   ↓
9. User can browse internet (firewall is open)
```

## Troubleshooting

### "Invalid access method" Error

**Possible causes:**
1. User accessed portal directly without being redirected by router
2. `uamip` parameter is missing from request

**Solutions:**
- Verify user is connected to WiFi network
- Check that uspot is configured correctly
- Verify uspot is sending `uamip` parameter in redirect URL

### Authentication Fails

**Possible causes:**
1. Wrong RADIUS server IP in router config
2. Wrong RADIUS secret in router config
3. User credentials invalid
4. RADIUS server unreachable from router

**Solutions:**
- Verify router's RADIUS configuration: `uci show uspot`
- Check router's RADIUS secret matches FreeRADIUS config
- Verify user exists in RADIUS database
- Test RADIUS connectivity from router: `radtest username password radius-server:1812 secret nas-ip`

### "Portal Loop" (User keeps getting redirected back)

**Possible causes:**
1. Form is submitting to Cloud API instead of router
2. Router's UAM endpoint is not responding
3. Router firewall not opening after auth

**Solutions:**
- Verify form action points to `http://<uamip>:<uamport>/login`
- Check router's uspot service is running: `/etc/init.d/uspot status`
- Check router logs: `logread | grep uspot`
- Verify router can reach RADIUS server

## Security Considerations

1. **HTTPS Required**: Portal should be accessed via HTTPS in production
2. **Router Security**: Router's RADIUS secret must be kept secure
3. **Cloud Portal is UI Only**: Cloud API serves only the login form UI; all authentication is handled by the router
4. **Logging**: Log authentication attempts but never log passwords

## Remote Disconnect

To remotely disconnect a user session:

1. **Via API**: `POST /api/sessions/:sessionId/disconnect` (Admin only)
   - Sends WebSocket command to router: `ubus call uspot client_remove {address: MAC}`
   - Router kicks the user and closes firewall
   - Database is updated with session stop time

2. **Via Router**: Direct ubus call on router
   ```bash
   ubus call uspot client_remove '{"address": "AA:BB:CC:DD:EE:FF"}'
   ```

**Note:** Remote disconnect uses WebSocket RPC, which is more reliable than UDP CoA over the internet (especially with NAT).

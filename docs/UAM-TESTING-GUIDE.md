# UAM Server Testing Guide

Complete guide to test UAM server on any router that supports UAM/WISPr.

## Prerequisites

1. **Database seeded** - Run seed script to create test data
2. **API server running** - Your SpotFi API should be running
3. **Router with UAM support** - Any router supporting UAM/WISPr (OpenWRT, MikroTik, etc.)
4. **RADIUS server** - Your RADIUS server should be accessible

## Step 1: Seed Database

```bash
cd packages/prisma
npx prisma db seed
```

This creates:
- Admin user: `admin@spotfi.com` / `admin123`
- Host user: `host@spotfi.com` / `host123`
- Test router with token: `test-router-token-123`
- RADIUS test users: `testuser`/`testpass`, `demo`/`demo123`, etc.

## Step 2: Get Authentication Token

```bash
# Login as admin
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@spotfi.com",
    "password": "admin123"
  }'

# Response:
# {
#   "user": { ... },
#   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
# }

# Save the token
export TOKEN="your-jwt-token-here"
```

## Step 3: Create/Register Router

If testing with a new router, create it first:

```bash
# Create router
curl -X POST http://localhost:8080/api/routers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Test Router",
    "macAddress": "00:11:22:33:44:55",
    "location": "Test Location"
  }'

# Response includes router ID and token
# Save router ID
export ROUTER_ID="router-id-from-response"
```

Or use existing router from seed:
```bash
# Get router ID
curl -X GET http://localhost:8080/api/routers \
  -H "Authorization: Bearer $TOKEN" | jq '.routers[0].id'

export ROUTER_ID="router-id-from-response"
```

## Step 4: Configure Router via API

Configure UAM server and RADIUS settings:

```bash
curl -X POST http://localhost:8080/api/routers/$ROUTER_ID/uam/configure \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "uamServerUrl": "http://localhost:8080/uam/login",
    "uamSecret": "test-uam-secret-123",
    "radiusServer": "127.0.0.1",
    "radiusSecret": "testing123",
    "restartUspot": true
  }'
```

**For production:**
```bash
curl -X POST http://localhost:8080/api/routers/$ROUTER_ID/uam/configure \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "uamServerUrl": "https://api.spotfi.com/uam/login",
    "uamSecret": "your-secure-uam-secret-min-32-chars",
    "radiusServer": "your-radius-server.com",
    "radiusSecret": "your-radius-secret",
    "radiusServer2": "backup-radius-server.com",
    "restartUspot": true
  }'
```

## Step 5: Manual Router Configuration (If API Not Available)

If router is not connected via WebSocket bridge, configure manually:

### OpenWRT with uspot:
```bash
ssh root@router-ip

uci set uspot.@instance[0].portal_url="http://localhost:8080/uam/login?uamsecret=test-uam-secret-123"
uci set uspot.@instance[0].radius_auth_server="127.0.0.1"
uci set uspot.@instance[0].radius_secret="testing123"
uci commit uspot
/etc/init.d/uspot restart
```

### MikroTik:
```
/ip hotspot profile set [find name=default] hotspot-address=10.1.30.1
/ip hotspot profile set [find name=default] http-proxy=10.1.30.1:80
/ip hotspot user profile set [find name=default] http-proxy=10.1.30.1:80
/ip hotspot set [find] html-directory=hotspot
/ip hotspot set [find] html-directory-override=hotspot
/ip hotspot set [find] use-radius=yes
/ip hotspot set [find] radius-secret=testing123
/ip hotspot set [find] radius-accounting=yes
```

## Step 6: Test UAM Endpoints

### Test 1: GET Login Page (Simulate Router Redirect)

```bash
# Simulate router redirecting user to UAM server
curl -X GET "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=test-uam-secret-123&nasid=$ROUTER_ID" \
  -H "User-Agent: Mozilla/5.0" \
  -v

# Should return HTML login page
```

### Test 2: POST Login (Authenticate User)

```bash
# Test with valid credentials
curl -X POST "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=test-uam-secret-123&nasid=$ROUTER_ID" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -v -L

# Should redirect to http://www.google.com on success
```

### Test 3: Test Invalid Credentials

```bash
curl -X POST "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=test-uam-secret-123" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=wrongpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -v -L

# Should redirect back to login page with error
```

### Test 4: Test RFC8908 Captive Portal API

```bash
curl -X GET "http://localhost:8080/api?nasid=$ROUTER_ID" \
  -H "User-Agent: CaptiveNetworkSupport/1.0 wispr" \
  -v

# Should return:
# {
#   "captive": true,
#   "user-portal-url": "http://localhost:8080/uam/login?nasid=..."
# }
```

## Step 7: Test with Real Router

### Setup Router

1. **Connect router to network** (ensure it can reach your API server)
2. **Configure router manually** or via API if WebSocket bridge is connected
3. **Connect device to router's WiFi**

### Expected Flow

1. Device connects to WiFi
2. Device tries to access any website
3. Router intercepts and redirects to: `http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=test-uam-secret-123`
4. User sees login page
5. User enters credentials (e.g., `testuser` / `testpass`)
6. UAM server authenticates via RADIUS
7. UAM server sends CoA to router (if router supports it)
8. User is redirected to `http://www.google.com`
9. User can now browse internet

## Step 8: Verify Authentication

### Check RADIUS Logs

```bash
# If using FreeRADIUS, check logs
tail -f /var/log/freeradius3/radius.log

# Look for:
# Access-Request for testuser
# Access-Accept for testuser
```

### Check API Logs

```bash
# Check API server logs for UAM activity
# Should see:
# [UAM] Authenticating testuser via RADIUS server...
# [UAM] Authentication successful for testuser
# [UAM] CoA sent to router (if router supports it)
```

### Check Router Status

```bash
# On OpenWRT router
ubus call uspot client_list

# Should show authenticated users
```

## Step 9: Test Different Scenarios

### Scenario 1: Invalid UAM Secret

```bash
curl -X GET "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=wrong-secret" \
  -v

# Should return: 403 Forbidden - "Invalid UAM Secret"
```

### Scenario 2: Missing UAM IP

```bash
curl -X GET "http://localhost:8080/uam/login?userurl=http://www.google.com" \
  -v

# Should return: 400 Bad Request - "Invalid Access: No NAS IP detected."
```

### Scenario 3: RADIUS Server Unavailable

```bash
# Configure router with wrong RADIUS server
# Try to login
# Should see error in logs and redirect with error message
```

## Step 10: Environment Variables

Ensure your `.env` file has:

```bash
UAM_SECRET=test-uam-secret-123
UAM_SERVER_URL=http://localhost:8080/uam/login
RADIUS_SERVER_1=127.0.0.1
RADIUS_SECRET=testing123
RADIUS_PORT=1812
API_URL=http://localhost:8080
```

## Troubleshooting

### Issue: "Invalid UAM Secret"

**Check:**
- UAM_SECRET in `.env` matches router configuration
- Router is sending `uamsecret` parameter correctly

**Fix:**
```bash
# Verify UAM secret
echo $UAM_SECRET

# Check router config
curl -X GET "http://localhost:8080/api/routers/$ROUTER_ID/uam/config" \
  -H "Authorization: Bearer $TOKEN"
```

### Issue: "Authentication Failed"

**Check:**
- RADIUS server is running and accessible
- User exists in RADIUS database
- RADIUS secret matches

**Fix:**
```bash
# Test RADIUS directly
echo "User-Name=testuser,User-Password=testpass" | \
  radclient 127.0.0.1:1812 auth testing123

# Check RADIUS users
# For FreeRADIUS:
mysql -u root -p radius -e "SELECT * FROM radcheck WHERE username='testuser';"
```

### Issue: "Router Not Found"

**Check:**
- Router ID is correct
- Router is registered in database

**Fix:**
```bash
# List all routers
curl -X GET "http://localhost:8080/api/routers" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Quick Test Script

Save as `test-uam.sh`:

```bash
#!/bin/bash

API_URL="http://localhost:8080"
TOKEN="your-token-here"
ROUTER_ID="your-router-id-here"
UAM_SECRET="test-uam-secret-123"

echo "Testing UAM Server..."

# Test 1: Login Page
echo "1. Testing GET login page..."
curl -s "$API_URL/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=$UAM_SECRET&nasid=$ROUTER_ID" | grep -q "SpotFi" && echo "✓ Login page works" || echo "✗ Login page failed"

# Test 2: RFC8908 API
echo "2. Testing RFC8908 API..."
curl -s "$API_URL/api?nasid=$ROUTER_ID" | grep -q "captive" && echo "✓ RFC8908 API works" || echo "✗ RFC8908 API failed"

# Test 3: Authentication
echo "3. Testing authentication..."
RESPONSE=$(curl -s -L -X POST "$API_URL/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&uamsecret=$UAM_SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com")

echo "$RESPONSE" | grep -q "google.com" && echo "✓ Authentication works" || echo "✗ Authentication failed"

echo "Done!"
```

## Test Users from Seed

Use these credentials for testing:

- `testuser` / `testpass`
- `demo` / `demo123`
- `john.doe` / `password123`
- `jane.smith` / `secure456`

## Next Steps

1. Test with real router and device
2. Monitor logs for errors
3. Test CoA functionality (if router supports it)
4. Test session management
5. Test quota limits (if configured)


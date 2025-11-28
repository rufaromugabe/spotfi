# Quick UAM Test Guide

Test your UAM server with the current setup (FreeRADIUS + seeded data).

## Current Setup Status

✅ **FreeRADIUS**: Running on port 1812 (auth), 1813 (acct)  
✅ **Database**: Connected, 3 NAS clients loaded  
✅ **API Server**: Running on localhost:8080  
✅ **Test Users**: Available from seed.ts

## Immediate Test (No Setup Required)

### Test 1: Login Page

```bash
curl "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com"
```

**Expected:** HTML login page

### Test 2: Authentication

```bash
curl -X POST "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -L -v
```

**Expected:** Redirect to `http://www.google.com`

### Test 3: RFC8908 API

```bash
curl "http://localhost:8080/api"
```

**Expected:** `{"captive":true,"user-portal-url":"..."}`

## Full Test Flow

### Step 1: Get Authentication Token

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@spotfi.com","password":"admin123"}' | jq -r '.token')

echo "Token: $TOKEN"
```

### Step 2: Get Router ID

```bash
ROUTER_ID=$(curl -s -X GET http://localhost:8080/api/routers \
  -H "Authorization: Bearer $TOKEN" | jq -r '.routers[0].id')

echo "Router ID: $ROUTER_ID"
```

### Step 3: Configure UAM Server (If Router Connected)

```bash
curl -X POST http://localhost:8080/api/routers/$ROUTER_ID/uam/configure \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "uamServerUrl": "http://localhost:8080/uam/login",
    "radiusServer": "127.0.0.1",
    "radiusSecret": "testing123",
    "restartUspot": false
  }'
```

**Note:** Use `127.0.0.1` for localhost, or your FreeRADIUS container IP if in Docker.

### Step 4: Test All Endpoints

```bash
# Run automated test script
./scripts/test-uam.sh
```

Or test manually:

```bash
# 1. Login Page
curl "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&nasid=$ROUTER_ID"

# 2. RFC8908 API
curl "http://localhost:8080/api?nasid=$ROUTER_ID"

# 3. Authentication (valid)
curl -X POST "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=testpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -L

# 4. Authentication (invalid)
curl -X POST "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=testuser&password=wrongpass&uamip=10.1.30.1&uamport=80&userurl=http://www.google.com" \
  -L
```

## Test RADIUS Directly

Test if FreeRADIUS is working:

```bash
# Install radclient if needed
# Ubuntu/Debian: sudo apt-get install freeradius-utils
# macOS: brew install freeradius

# Test authentication
echo "User-Name=testuser,User-Password=testpass" | \
  radclient 127.0.0.1:1812 auth testing123

# Expected output:
# Received response ID 123, code 2, length = 20
# (0) Access-Accept
```

## Test Users (from seed.ts)

| Username | Password | Session Timeout |
|----------|----------|-----------------|
| testuser | testpass | 1 hour |
| demo | demo123 | 30 minutes |
| john.doe | password123 | 2 hours |
| jane.smith | secure456 | 4 hours |

## Monitor Logs

### FreeRADIUS Logs
```bash
# Watch FreeRADIUS logs
docker logs -f spotfi-freeradius

# Look for:
# - Access-Request for testuser
# - Access-Accept or Access-Reject
```

### API Logs
```bash
# Watch API logs
docker logs -f spotfi-api

# Look for:
# [UAM] Authenticating testuser via RADIUS server...
# [UAM] Authentication successful for testuser
```

## Testing with Real Router

### Option 1: Router Connected via WebSocket Bridge

If router is online and connected:

1. **Configure via API** (Step 3 above)
2. **Connect device to router WiFi**
3. **Try to access any website**
4. **Should redirect to login page**

### Option 2: Manual Router Configuration

**OpenWRT with uspot:**
```bash
ssh root@router-ip

uci set uspot.@instance[0].portal_url="http://localhost:8080/uam/login"
uci set uspot.@instance[0].radius_auth_server="127.0.0.1"
uci set uspot.@instance[0].radius_secret="testing123"
uci commit uspot
/etc/init.d/uspot restart
```

**MikroTik:**
```
/ip hotspot profile set [find name=default] hotspot-address=10.1.30.1
/ip hotspot set [find] use-radius=yes
/ip hotspot set [find] radius-secret=testing123
/ip hotspot set [find] radius-accounting=yes
```

## Environment Variables

Make sure your `.env` has:

```bash
UAM_SERVER_URL=http://localhost:8080/uam/login
RADIUS_SERVER_1=127.0.0.1
RADIUS_SECRET=testing123
RADIUS_PORT=1812
API_URL=http://localhost:8080
```

## Troubleshooting

### Issue: "Authentication Failed"

**Check:**
```bash
# Test RADIUS directly
echo "User-Name=testuser,User-Password=testpass" | \
  radclient 127.0.0.1:1812 auth testing123

# Check user in database
docker exec -it spotfi-postgres psql -U postgres -d spotfi -c "SELECT * FROM radcheck WHERE username='testuser';"

# Check FreeRADIUS logs
docker logs spotfi-freeradius | tail -20
```

### Issue: "Router Not Found"

**Check:**
```bash
# List all routers
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@spotfi.com","password":"admin123"}' | jq -r '.token')

curl -X GET http://localhost:8080/api/routers \
  -H "Authorization: Bearer $TOKEN" | jq '.routers[] | {id, name}'
```

## Complete One-Liner Test

```bash
# Get token, router ID, configure, and test
TOKEN=$(curl -s -X POST http://localhost:8080/api/auth/login -H "Content-Type: application/json" -d '{"email":"admin@spotfi.com","password":"admin123"}' | jq -r '.token') && \
ROUTER_ID=$(curl -s -X GET http://localhost:8080/api/routers -H "Authorization: Bearer $TOKEN" | jq -r '.routers[0].id') && \
echo "Router ID: $ROUTER_ID" && \
curl -X POST http://localhost:8080/api/routers/$ROUTER_ID/uam/configure -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"uamServerUrl":"http://localhost:8080/uam/login","radiusServer":"127.0.0.1","radiusSecret":"testing123"}' && \
echo "" && \
echo "Testing login page..." && \
curl -s "http://localhost:8080/uam/login?uamip=10.1.30.1&uamport=80&userurl=http://www.google.com&nasid=$ROUTER_ID" | grep -q "SpotFi" && echo "✓ Login page works" || echo "✗ Login page failed"
```
